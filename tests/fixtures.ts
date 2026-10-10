/** What storage/logs/laravel.log looks like, including an exception thrown inside vendor/. */
export const LOG = [
  '[2026-10-10 08:00:00] local.INFO: User 1 logged in',
  '[2026-10-10 08:00:30] local.WARNING: Cache miss for key orders:1 []',
  '[2026-10-10 08:01:02] local.ERROR: Call to undefined method App\\Models\\Order::total() {"userId":1,"exception":"[object] (BadMethodCallException(code: 0): Call to undefined method App\\\\Models\\\\Order::total() at /Users/mark/Sites/shop/vendor/laravel/framework/src/Illuminate/Support/Traits/ForwardsCalls.php:67)',
  '[stacktrace]',
  "#0 /Users/mark/Sites/shop/vendor/laravel/framework/src/Illuminate/Support/Traits/ForwardsCalls.php(36): Illuminate\\Support\\Traits\\ForwardsCalls::throwBadMethodCallException('total')",
  '#1 /Users/mark/Sites/shop/app/Http/Controllers/OrderController.php(42): Illuminate\\Database\\Eloquent\\Model->forwardCallTo()',
  '#2 {main}',
  '"} ',
  '',
].join('\n')
