# Example: container-deployment-review

A before/after walkthrough for containerizing a .NET 8 ASP.NET Core API.
The **before** image is a single-stage, root-running build that bakes a connection string into an `ENV` instruction.
The **after** image is a hardened multi-stage chiseled non-root image with platform-managed secrets, liveness/readiness probes, and resource limits.

---

## BEFORE — single-stage, root, secret in ENV

```dockerfile
# BEFORE — do not ship this
FROM mcr.microsoft.com/dotnet/sdk:8.0

WORKDIR /app
COPY . .
RUN dotnet publish -c Release -o /app/publish

# Secret baked into every image layer — visible in docker inspect and the registry
ENV ConnectionStrings__Default="Server=prod-sql.database.windows.net;Database=MyApp;User Id=app;Password=S3cr3t!;"
ENV ASPNETCORE_ENVIRONMENT=Production

EXPOSE 80
# No USER directive — runs as root (UID 0)
ENTRYPOINT ["dotnet", "/app/publish/MyApi.dll"]
```

**Problems:**

| Problem | Impact |
|---------|--------|
| Single stage — SDK ships to production | ~3× image size; compilers, NuGet cache, and build toolchain exposed |
| No `USER` directive | Process runs as UID 0 (root) inside the container |
| `ENV ConnectionStrings__Default=...` | Connection string is baked into the image layer; visible in `docker inspect`, the registry, and any CI log |
| `EXPOSE 80` + port 80 binding | Binding port 80 requires root on Linux; no `ASPNETCORE_HTTP_PORTS` set for non-root |
| `FROM sdk:8.0` with no digest | Mutable tag — upstream changes silently alter the deployed image |
| No `.dockerignore` | `bin/`, `obj/`, local `.env`, and user secrets enter the build context |
| No health probes configured | Kubernetes cannot restart a deadlocked pod or gate traffic during startup |

---

## AFTER — multi-stage chiseled non-root, secrets via platform

### .dockerignore

```
bin/
obj/
*.user
*.pfx
.env
appsettings.*.json
!appsettings.json
```

### Dockerfile

```dockerfile
# Stage 1 — build and publish (SDK stays here, never reaches production)
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore as a separate layer for better cache reuse
COPY MyApi.csproj ./
RUN dotnet restore

# Copy source and publish release output
COPY . ./
RUN dotnet publish MyApi.csproj -c Release -o /app/publish --no-restore

# Stage 2 — runtime (chiseled: no shell, no apt, ~half the size of standard aspnet)
# Pin by digest in production: mcr.microsoft.com/dotnet/aspnet:8.0-jammy-chiseled@sha256:<digest>
FROM mcr.microsoft.com/dotnet/aspnet:8.0-jammy-chiseled AS runtime

WORKDIR /app

# Copy only the published output from the build stage
COPY --from=build /app/publish .

# .NET 8+ runtime images define APP_UID=1654; chiseled images default to non-root.
# This directive is explicit for clarity and for non-chiseled base images.
USER $APP_UID

# Bind to port 8080 — does not require root (unlike port 80)
ENV ASPNETCORE_HTTP_PORTS=8080
ENV ASPNETCORE_ENVIRONMENT=Production
# Server GC creates one heap per logical CPU; disable it in memory-constrained containers
ENV DOTNET_gcServer=0

EXPOSE 8080

ENTRYPOINT ["dotnet", "MyApi.dll"]
```

**What changed and why:**

| Change | Reason |
|--------|--------|
| Two-stage build (SDK → chiseled runtime) | SDK never ships; runtime image is ~60 MB vs ~220 MB; chiseled has no shell |
| `USER $APP_UID` (UID 1654) | Process is non-root; binding port 8080 requires no special capability |
| `ASPNETCORE_HTTP_PORTS=8080` | Non-root-safe port; matches the `EXPOSE` and the probe paths |
| `DOTNET_gcServer=0` | Prevents server GC from creating one heap per CPU in a 1-vCPU container |
| No `ENV` secret | Connection string injected at runtime via platform (see below) |
| Pinned base tag (digest in production) | Immutable reference; upstream tag mutation cannot silently change the image |
| `.dockerignore` excludes `bin/`, `obj/`, secrets | Keeps the build context clean; no accidental secret leakage into layers |

---

### Secrets via platform — not the image

**Azure Container Apps — secret reference:**

```yaml
# container-app.yaml (Azure Container Apps manifest)
properties:
  configuration:
    secrets:
      - name: db-connection-string
        value: "Server=prod-sql.database.windows.net;Database=MyApp;..."  # injected from Key Vault reference
  template:
    containers:
      - name: myapi
        image: myacr.azurecr.io/myapi:1.2.3
        env:
          - name: ConnectionStrings__Default
            secretRef: db-connection-string   # resolved at runtime; never in the image
```

**Kubernetes — Secret + env injection:**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: myapi-secrets
  namespace: myapp
type: Opaque
stringData:
  connection-string: "Server=prod-sql.database.windows.net;Database=MyApp;..."
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapi
  namespace: myapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: myapi
  template:
    metadata:
      labels:
        app: myapi
    spec:
      # Prevent writing executables to the container filesystem at runtime
      securityContext:
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 1654
      containers:
        - name: myapi
          image: myacr.azurecr.io/myapi:1.2.3@sha256:<digest>
          ports:
            - containerPort: 8080
          env:
            - name: ConnectionStrings__Default
              valueFrom:
                secretKeyRef:
                  name: myapi-secrets
                  key: connection-string
            - name: ASPNETCORE_HTTP_PORTS
              value: "8080"
            - name: DOTNET_gcServer
              value: "0"
          # Resource requests (scheduler) and limits (cgroup cap)
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          # Liveness: is the process alive? Never check external dependencies here.
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
          # Readiness: is the app ready to serve traffic (including downstream checks)?
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
      # Allow 30 s for SIGTERM draining before SIGKILL
      terminationGracePeriodSeconds: 30
```

---

### Health check wiring in the .NET app

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks()
    // Readiness: add downstream checks here (SQL, cache, etc.)
    .AddSqlServer(
        builder.Configuration.GetConnectionString("Default")!,
        name: "sql",
        tags: ["ready"]);

// Match terminationGracePeriodSeconds; host drains before the pod is killed
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(25));

var app = builder.Build();

// Liveness — the process is alive (no external dependency checks)
app.MapHealthChecks("/healthz/live", new HealthCheckOptions
{
    Predicate = _ => false,   // skip all registered checks; just return 200 if the host is running
    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
});

// Readiness — app is ready to receive traffic
app.MapHealthChecks("/healthz/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
});

app.Run();
```

---

### Findings summary

| Finding | Severity | Fix |
|---------|----------|-----|
| Single-stage SDK image | High | Multi-stage build: SDK stage → chiseled runtime stage |
| Secret in `ENV ConnectionStrings__Default` | High | Inject via Container Apps `secretRef` or K8s `secretKeyRef` at runtime |
| `USER root` (absent `USER`) | High | `USER $APP_UID` in runtime stage; bind port 8080 not 80 |
| No health probes | Medium | `MapHealthChecks` + `livenessProbe` / `readinessProbe` in manifest |
| No resource `limits` | Medium | Set `resources.limits.cpu` + `resources.limits.memory` |
| Mutable `latest`-style tag | Medium | Pin to specific version + digest |
| Missing `.dockerignore` | Medium | Exclude `bin/`, `obj/`, secrets, local config overrides |
| No `DOTNET_gcServer=0` | Low | Set for single-vCPU containers to avoid heap over-allocation |
| No `readOnlyRootFilesystem` | Low | Set `securityContext.readOnlyRootFilesystem: true` where app does not write to disk |
