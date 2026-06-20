# Example: dotnet-security-review

A worked review of an `OrdersController` with two classic security defects: IDOR (broken object-level authorization) and SQL injection via `FromSqlRaw` string concatenation.

---

## BEFORE — vulnerable controller

```csharp
// OrdersController.cs
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class OrdersController : ControllerBase
{
    private readonly AppDbContext _db;

    public OrdersController(AppDbContext db) => _db = db;

    // GET api/orders/42
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetOrder(int id)
    {
        // BUG 1 — IDOR: fetches any order by id with no ownership check.
        // Any authenticated user can read any other user's order.
        var order = await _db.Orders.FindAsync(id);
        if (order is null) return NotFound();
        return Ok(order);
    }

    // GET api/orders/search?status=Shipped
    [HttpGet("search")]
    public async Task<IActionResult> Search(string status)
    {
        // BUG 2 — SQL injection: user-supplied `status` is concatenated
        // directly into the raw SQL string without parameterization.
        var orders = await _db.Orders
            .FromSqlRaw($"SELECT * FROM Orders WHERE Status = '{status}'")
            .ToListAsync();
        return Ok(orders);
    }
}
```

---

## Findings

| # | Endpoint | Severity | Finding | Why it matters |
|---|----------|----------|---------|----------------|
| 1 | `GET /api/orders/{id}` | **Critical** | IDOR — no ownership check | `FindAsync(id)` returns the row for any id regardless of which user is authenticated. Attacker enumerates integers to harvest other users' orders. |
| 2 | `GET /api/orders/search` | **Critical** | SQL injection via `FromSqlRaw` + string interpolation | `$"…'{status}'"` builds the SQL string from untrusted query-string input. Attacker passes `' OR '1'='1` to return all orders, or `'; DROP TABLE Orders;--` to destroy data. |

---

## AFTER — fixed controller

```csharp
// OrdersController.cs
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class OrdersController : ControllerBase
{
    private readonly AppDbContext _db;

    public OrdersController(AppDbContext db) => _db = db;

    // GET api/orders/42
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetOrder(int id)
    {
        // FIX 1 — ownership check: resolve the caller's identity first,
        // then assert the order belongs to them before returning it.
        var callerId = User.FindFirstValue(ClaimTypes.NameIdentifier);

        var order = await _db.Orders
            .FirstOrDefaultAsync(o => o.Id == id && o.OwnerId == callerId);

        if (order is null) return NotFound(); // same response for not-found and not-owned
        return Ok(new OrderDto(order));       // project to DTO, never return EF entity
    }

    // GET api/orders/search?status=Shipped
    [HttpGet("search")]
    public async Task<IActionResult> Search(string status)
    {
        // FIX 2a — prefer LINQ (compiled to parameterized SQL by EF Core):
        var callerId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var orders = await _db.Orders
            .Where(o => o.Status == status && o.OwnerId == callerId)
            .Select(o => new OrderDto(o))
            .ToListAsync();

        // FIX 2b — if raw SQL is genuinely required, use FromSqlInterpolated,
        // which parameterizes each interpolated hole automatically:
        //
        //   var orders = await _db.Orders
        //       .FromSqlInterpolated($"SELECT * FROM Orders WHERE Status = {status}")
        //       .ToListAsync();
        //
        // Never use FromSqlRaw with string concatenation or interpolation.

        return Ok(orders);
    }
}
```

### Why each fix works

**Fix 1 — IDOR** (`FindAsync` → `FirstOrDefaultAsync` with predicate):  
`FindAsync(id)` issues `SELECT … WHERE Id = @id` with no user filter. Replacing it with `FirstOrDefaultAsync(o => o.Id == id && o.OwnerId == callerId)` pushes the ownership assertion into the database query so no second round-trip is needed and there is no TOCTOU window. Returning `NotFound()` for both "row missing" and "row owned by someone else" prevents enumeration.

**Fix 2 — SQL injection** (string interpolation → LINQ or `FromSqlInterpolated`):  
`FromSqlRaw($"…'{status}'")` embeds the raw string into SQL before the database sees it. `FromSqlInterpolated($"… {status}")` uses `FormattableString` to extract each hole as a `DbParameter`, so the database always treats the value as data, never as SQL syntax. The LINQ version is preferable because EF Core compiles it to a fully parameterized query and it also applies the ownership filter.
