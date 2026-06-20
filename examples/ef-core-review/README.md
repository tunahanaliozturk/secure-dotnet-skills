# Example: ef-core-review

A worked review of a `ProductRepository` with two classic EF Core defects: an N+1 loop caused by a missing `Include`, and a `FromSqlRaw` search built from string concatenation.

---

## BEFORE — defective repository

```csharp
// ProductRepository.cs
public class ProductRepository
{
    private readonly AppDbContext _db;

    public ProductRepository(AppDbContext db) => _db = db;

    // Returns each product with its category name.
    // BUG 1 — N+1: loads all Products without including Category,
    // then accesses category.Name inside the loop, triggering one
    // SELECT per product.
    public async Task<List<ProductDto>> GetAllWithCategoryAsync()
    {
        var products = await _db.Products.ToListAsync(); // SELECT * FROM Products

        var result = new List<ProductDto>();
        foreach (var p in products)
        {
            result.Add(new ProductDto
            {
                Id    = p.Id,
                Name  = p.Name,
                // Lazy-loads Category here — one extra SELECT per row.
                Category = p.Category.Name
            });
        }
        return result;
    }

    // Full-text search over product name.
    // BUG 2 — SQL injection: user-supplied `term` is concatenated
    // into the raw SQL string without parameterization.
    public async Task<List<Product>> SearchAsync(string term)
    {
        var sql = $"SELECT * FROM Products WHERE Name LIKE '%{term}%'";
        return await _db.Products
            .FromSqlRaw(sql)   // term injected verbatim — no parameterization
            .ToListAsync();
    }
}
```

---

## Findings

| # | Method | Severity | Finding | Why it matters |
|---|--------|----------|---------|----------------|
| 1 | `GetAllWithCategoryAsync` | **High** | N+1 — `Category` navigation accessed in loop without `Include` | With 500 products, EF Core issues 501 round-trips: 1 for the product list and 500 for individual `Category` loads via lazy loading. Response latency scales linearly with row count. |
| 2 | `GetAllWithCategoryAsync` | **Medium** | Full entity materialized; no `AsNoTracking` on a read-only query | All `Product` columns are fetched and change-tracking snapshots are allocated even though results are never saved. Project to a DTO and add `AsNoTracking`. |
| 3 | `SearchAsync` | **Critical** | SQL injection via `FromSqlRaw` + string concatenation | `term` is embedded directly into the SQL string. An attacker passes `' OR '1'='1` to return all products, or `'; DROP TABLE Products;--` to drop data. `FromSqlRaw` does not parameterize interpolated or concatenated strings. |

---

## AFTER — fixed repository

```csharp
// ProductRepository.cs
public class ProductRepository
{
    private readonly AppDbContext _db;

    public ProductRepository(AppDbContext db) => _db = db;

    // FIX 1 — eager-load Category with Include, project to DTO with Select,
    // and add AsNoTracking because these results are never saved.
    public async Task<List<ProductDto>> GetAllWithCategoryAsync()
    {
        return await _db.Products
            .AsNoTracking()                        // no change-tracking snapshots
            .Include(p => p.Category)              // one JOIN — no per-row lazy load
            .Select(p => new ProductDto            // project at the database level
            {
                Id       = p.Id,
                Name     = p.Name,
                Category = p.Category.Name         // translated to SQL column in the SELECT
            })
            .ToListAsync();
        // Result: exactly 1 SQL query with a JOIN, returning only the three
        // projected columns.  With 500 products: 1 round-trip instead of 501.
    }

    // FIX 2 — use FromSqlInterpolated instead of FromSqlRaw.
    // EF Core extracts each interpolated hole as a DbParameter automatically,
    // so `term` is always treated as a bound value, never as SQL syntax.
    public async Task<List<ProductSummaryDto>> SearchAsync(string term)
    {
        var pattern = $"%{term}%"; // build the LIKE pattern in .NET first

        return await _db.Products
            .FromSqlInterpolated($"SELECT Id, Name FROM Products WHERE Name LIKE {pattern}")
            .AsNoTracking()
            .Select(p => new ProductSummaryDto { Id = p.Id, Name = p.Name })
            .ToListAsync();

        // If LINQ is sufficient (it usually is), prefer it — EF Core always
        // parameterizes LINQ predicates:
        //
        //   return await _db.Products
        //       .AsNoTracking()
        //       .Where(p => EF.Functions.Like(p.Name, pattern))
        //       .Select(p => new ProductSummaryDto { Id = p.Id, Name = p.Name })
        //       .ToListAsync();
    }
}
```

### Why each fix works

**Fix 1 — N+1** (`.ToListAsync()` → `.Include().Select().ToListAsync()`):  
Without `Include`, EF Core's lazy-loading proxy fires a `SELECT` from `Categories WHERE Id = @id` for every product in the loop. Adding `.Include(p => p.Category)` translates to a single `LEFT JOIN` in the generated SQL. Adding `.Select(p => new ProductDto { … })` pushes the column projection to the database so only three columns are transmitted, not the full `Product` and `Category` rows. `AsNoTracking()` tells EF Core not to allocate the identity map and snapshot entries — safe because the results go straight to the response and are never modified.

**Fix 2 — SQL injection** (`FromSqlRaw` + concatenation → `FromSqlInterpolated`):  
`FromSqlRaw(sql)` receives an already-constructed string; by the time EF Core sees it, the user input is already embedded as SQL text. `FromSqlInterpolated` accepts a `FormattableString` and uses each `{…}` argument as a `DbParameter`, so the database engine always sees a parameterized placeholder (`@p0`) bound to the literal string value — even if the value contains SQL keywords or quote characters. The LINQ `EF.Functions.Like` alternative is equally safe and avoids raw SQL entirely.
