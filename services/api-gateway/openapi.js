'use strict';
// OpenAPI 3.0 specification for the Crumb & Ember platform.
// Served by the gateway at /api/openapi.json and rendered at /api/docs.
// All paths are the *public* gateway paths (/api/...); the gateway strips
// the /api prefix before proxying to the owning service.

const svc = (name) => ({ name });

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Crumb & Ember — Bakery Platform API',
    version: '1.0.0',
    description:
      'Public API surface of the bakery microservices platform. ' +
      'Every route below is proxied by the api-gateway to the owning domain service. ' +
      'Use GET /api/status to see live upstream health.'
  },
  servers: [{ url: '/api', description: 'API gateway (Ingress /api prefix)' }],
  tags: [
    'gateway', 'auth', 'users', 'products', 'inventory', 'pricing', 'cart',
    'orders', 'payments', 'deliveries', 'notifications', 'reviews', 'search',
    'recommendations', 'promotions', 'loyalty', 'recipes', 'schedule',
    'suppliers', 'analytics', 'media', 'invoices', 'currency', 'language'
  ].map(svc),
  paths: {
    // ------------------------------------------------------------ gateway
    '/status': {
      get: {
        tags: ['gateway'], summary: 'Aggregated health of all upstream services',
        responses: { 200: { description: 'Per-service up/down map', content: { 'application/json': { schema: { $ref: '#/components/schemas/PlatformStatus' } } } } }
      }
    },
    // --------------------------------------------------------------- auth
    '/auth/register': {
      post: {
        tags: ['auth'], summary: 'Register a new account',
        requestBody: jsonBody({ email: str('jo@example.com'), password: str('s3cret!') }, ['email', 'password']),
        responses: { 201: ok('Account created'), 409: err('Email already registered') }
      }
    },
    '/auth/login': {
      post: {
        tags: ['auth'], summary: 'Log in, returns a bearer token',
        requestBody: jsonBody({ email: str('jo@example.com'), password: str('s3cret!') }, ['email', 'password']),
        responses: { 200: ok('Token issued'), 401: err('Invalid credentials') }
      }
    },
    '/auth/verify': {
      get: {
        tags: ['auth'], summary: 'Verify a bearer token',
        parameters: [hdr('authorization', 'Bearer <token>')],
        responses: { 200: ok('Token valid'), 401: err('Invalid or expired token') }
      }
    },
    '/auth/forgot-password': {
      post: {
        tags: ['auth'], summary: 'Request a password reset token for an account',
        requestBody: jsonBody({ email: str('jo@example.com') }, ['email']),
        responses: { 200: ok('Reset token issued if the email is registered (response shape does not reveal existence)') }
      }
    },
    '/auth/reset-password': {
      post: {
        tags: ['auth'], summary: 'Redeem a reset token to set a new password',
        requestBody: jsonBody({ token: str('<reset token>'), newPassword: str('n3wS3cret!') }, ['token', 'newPassword']),
        responses: { 200: ok('Password reset'), 400: err('Missing fields or password too short'), 401: err('Reset token invalid or expired') }
      }
    },
    '/auth/password': {
      post: {
        tags: ['auth'], summary: 'Update the logged-in account\'s password',
        parameters: [hdr('authorization', 'Bearer <token>')],
        requestBody: jsonBody({ currentPassword: str('s3cret!'), newPassword: str('n3wS3cret!') }, ['currentPassword', 'newPassword']),
        responses: { 200: ok('Password updated'), 400: err('Missing fields or password too short'), 401: err('Invalid token or current password incorrect') }
      }
    },
    // -------------------------------------------------------------- users
    '/users': { get: { tags: ['users'], summary: 'List users', responses: { 200: ok('User list') } } },
    '/users/{id}': {
      get: { tags: ['users'], summary: 'Get a user', parameters: [pathP('id')], responses: { 200: ok('User'), 404: err('Not found') } },
      put: { tags: ['users'], summary: 'Update a user', parameters: [pathP('id')], requestBody: jsonBody({ name: str('Jo Baker') }), responses: { 200: ok('Updated') } }
    },
    // ----------------------------------------------------------- products
    '/products': {
      get: {
        tags: ['products'], summary: 'List products',
        parameters: [{ name: 'category', in: 'query', required: false, schema: { type: 'string', enum: ['bread', 'viennoiserie', 'patisserie'] } }],
        responses: { 200: { description: 'Product list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } } }
      }
    },
    '/products/{id}': {
      get: { tags: ['products'], summary: 'Get a product', parameters: [pathP('id')], responses: { 200: { description: 'Product', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } }, 404: err('Not found') } },
      put: { tags: ['products'], summary: 'Create or update a product', parameters: [pathP('id')], requestBody: jsonBody({ name: str('Levain Country Loaf'), category: str('bread'), price: num(8.5), description: str('48-hour fermented sourdough.') }, ['name', 'category', 'price']), responses: { 200: ok('Upserted') } }
    },
    // ---------------------------------------------------------- inventory
    '/stock': { get: { tags: ['inventory'], summary: 'List stock levels', responses: { 200: ok('Stock list') } } },
    '/stock/{productId}': { get: { tags: ['inventory'], summary: 'Stock for one product', parameters: [pathP('productId')], responses: { 200: ok('Stock level'), 404: err('Not found') } } },
    '/stock/adjust': { post: { tags: ['inventory'], summary: 'Adjust stock', requestBody: jsonBody({ productId: str('p-1'), delta: num(-2) }, ['productId', 'delta']), responses: { 200: ok('Adjusted') } } },
    // ------------------------------------------------------------ pricing
    '/prices/{productId}': { get: { tags: ['pricing'], summary: 'Current price for a product', parameters: [pathP('productId')], responses: { 200: ok('Price'), 404: err('Not found') } } },
    '/quote': { post: { tags: ['pricing'], summary: 'Quote a basket total', requestBody: jsonBody({ items: { type: 'array', items: { type: 'object', properties: { productId: str('p-1'), quantity: num(2) } } } }, ['items']), responses: { 200: ok('Quote with totals') } } },
    // --------------------------------------------------------------- cart
    '/carts/{userId}': {
      get: { tags: ['cart'], summary: 'Get a cart', parameters: [pathP('userId')], responses: { 200: ok('Cart') } },
      delete: { tags: ['cart'], summary: 'Empty a cart', parameters: [pathP('userId')], responses: { 200: ok('Emptied') } }
    },
    '/carts/{userId}/items': { post: { tags: ['cart'], summary: 'Add an item', parameters: [pathP('userId')], requestBody: jsonBody({ productId: str('p-3'), quantity: num(1) }, ['productId']), responses: { 200: ok('Item added') } } },
    '/carts/{userId}/items/{productId}': { delete: { tags: ['cart'], summary: 'Remove an item', parameters: [pathP('userId'), pathP('productId')], responses: { 200: ok('Item removed') } } },
    // ------------------------------------------------------------- orders
    '/orders': {
      get: { tags: ['orders'], summary: 'List orders', responses: { 200: ok('Order list') } },
      post: { tags: ['orders'], summary: 'Place an order', requestBody: jsonBody({ userId: str('u-1'), items: { type: 'array', items: { type: 'object', properties: { productId: str('p-1'), quantity: num(1) } } } }, ['userId', 'items']), responses: { 201: ok('Order created') } }
    },
    '/orders/{id}': { get: { tags: ['orders'], summary: 'Get an order', parameters: [pathP('id')], responses: { 200: ok('Order'), 404: err('Not found') } } },
    '/orders/{id}/status': { put: { tags: ['orders'], summary: 'Update order status', parameters: [pathP('id')], requestBody: jsonBody({ status: str('baking') }, ['status']), responses: { 200: ok('Status updated') } } },
    // ----------------------------------------------------------- payments
    '/payments': { post: { tags: ['payments'], summary: 'Record a payment', requestBody: jsonBody({ orderId: str('o-1'), amount: num(12.75), method: str('card') }, ['orderId', 'amount']), responses: { 201: ok('Payment recorded') } } },
    '/payments/{id}': { get: { tags: ['payments'], summary: 'Get a payment', parameters: [pathP('id')], responses: { 200: ok('Payment'), 404: err('Not found') } } },
    '/payments/order/{orderId}': { get: { tags: ['payments'], summary: 'Payments for an order', parameters: [pathP('orderId')], responses: { 200: ok('Payment list') } } },
    '/payments/razorpay/order': { post: { tags: ['payments'], summary: 'Create a Razorpay order', requestBody: jsonBody({ orderId: str('o-1'), amount: num(1275) }, ['orderId', 'amount']), responses: { 200: ok('Razorpay order') } } },
    '/payments/razorpay/verify': { post: { tags: ['payments'], summary: 'Verify a Razorpay signature', requestBody: jsonBody({ razorpay_order_id: str(''), razorpay_payment_id: str(''), razorpay_signature: str('') }), responses: { 200: ok('Verified'), 400: err('Bad signature') } } },
    '/payments/razorpay/webhook': { post: { tags: ['payments'], summary: 'Razorpay webhook receiver', responses: { 200: ok('Acknowledged') } } },
    // --------------------------------------------------------- deliveries
    '/deliveries': { post: { tags: ['deliveries'], summary: 'Schedule a delivery', requestBody: jsonBody({ orderId: str('o-1'), address: str('12 Rye Lane') }, ['orderId', 'address']), responses: { 201: ok('Delivery scheduled') } } },
    '/deliveries/{orderId}': { get: { tags: ['deliveries'], summary: 'Delivery for an order', parameters: [pathP('orderId')], responses: { 200: ok('Delivery'), 404: err('Not found') } } },
    // ------------------------------------------------------ notifications
    '/notify/email': { post: { tags: ['notifications'], summary: 'Send an email', requestBody: jsonBody({ to: str('jo@example.com'), subject: str('Your order'), body: str('...') }, ['to', 'subject']), responses: { 202: ok('Queued') } } },
    '/notify/sms': { post: { tags: ['notifications'], summary: 'Send an SMS', requestBody: jsonBody({ to: str('+3161234'), body: str('...') }, ['to', 'body']), responses: { 202: ok('Queued') } } },
    // ------------------------------------------------------------ reviews
    '/reviews': { post: { tags: ['reviews'], summary: 'Post a review', requestBody: jsonBody({ productId: str('p-1'), userId: str('u-1'), rating: num(5), text: str('Great crust!') }, ['productId', 'rating']), responses: { 201: ok('Review created') } } },
    '/reviews/{productId}': { get: { tags: ['reviews'], summary: 'Reviews for a product', parameters: [pathP('productId')], responses: { 200: ok('Review list') } } },
    // ------------------------------------------------------------- search
    '/search': { get: { tags: ['search'], summary: 'Search products', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', example: 'croissant' } }], responses: { 200: ok('Search hits') } } },
    // ---------------------------------------------------- recommendations
    '/recommendations/{userId}': { get: { tags: ['recommendations'], summary: 'Recommendations for a user', parameters: [pathP('userId')], responses: { 200: ok('Recommended products') } } },
    // --------------------------------------------------------- promotions
    '/promotions': { get: { tags: ['promotions'], summary: 'Active promotions', responses: { 200: ok('Promotion list') } } },
    '/promotions/validate': { post: { tags: ['promotions'], summary: 'Validate a promo code', requestBody: jsonBody({ code: str('CRUMB10') }, ['code']), responses: { 200: ok('Valid'), 404: err('Unknown code') } } },
    // ------------------------------------------------------------ loyalty
    '/loyalty/{userId}': { get: { tags: ['loyalty'], summary: 'Loyalty balance', parameters: [pathP('userId')], responses: { 200: ok('Balance') } } },
    '/loyalty/{userId}/earn': { post: { tags: ['loyalty'], summary: 'Earn points', parameters: [pathP('userId')], requestBody: jsonBody({ points: num(10), reason: str('order o-1') }, ['points']), responses: { 200: ok('Points added') } } },
    // ------------------------------------------------------------ recipes
    '/recipes': { get: { tags: ['recipes'], summary: 'List recipes', responses: { 200: ok('Recipe list') } } },
    '/recipes/{id}': { get: { tags: ['recipes'], summary: 'Get a recipe', parameters: [pathP('id')], responses: { 200: ok('Recipe'), 404: err('Not found') } } },
    // ----------------------------------------------------------- schedule
    '/schedule/today': { get: { tags: ['schedule'], summary: "Today's oven schedule", responses: { 200: { description: 'Bakes for today', content: { 'application/json': { schema: { $ref: '#/components/schemas/Schedule' } } } } } } },
    // ---------------------------------------------------------- suppliers
    '/suppliers': { get: { tags: ['suppliers'], summary: 'List suppliers', responses: { 200: ok('Supplier list') } } },
    '/suppliers/{id}/orders': { get: { tags: ['suppliers'], summary: 'Purchase orders for a supplier', parameters: [pathP('id')], responses: { 200: ok('PO list') } } },
    // ---------------------------------------------------------- analytics
    '/events': { post: { tags: ['analytics'], summary: 'Ingest an analytics event', requestBody: jsonBody({ type: str('page_view'), payload: { type: 'object' } }, ['type']), responses: { 202: ok('Accepted') } } },
    '/metrics/summary': { get: { tags: ['analytics'], summary: 'Metrics summary', responses: { 200: ok('Summary') } } },
    // -------------------------------------------------------------- media
    '/media/{productId}': { get: { tags: ['media'], summary: 'Media assets for a product', parameters: [pathP('productId')], responses: { 200: ok('Asset list') } } },
    // ----------------------------------------------------------- invoices
    '/invoices': { post: { tags: ['invoices'], summary: 'Create an invoice', requestBody: jsonBody({ orderId: str('o-1') }, ['orderId']), responses: { 201: ok('Invoice created') } } },
    '/invoices/{id}': { get: { tags: ['invoices'], summary: 'Get an invoice', parameters: [pathP('id')], responses: { 200: ok('Invoice'), 404: err('Not found') } } },
    // ----------------------------------------------------------- currency
    '/currency': { get: { tags: ['currency'], summary: 'List all supported currencies with symbols and EUR rates', responses: { 200: ok('47+ currencies incl. INR, AED, CNY, GBP, JPY, USD') } } },
    '/currency/rates': { get: { tags: ['currency'], summary: 'Rate table rebased onto any currency', parameters: [{ name: 'base', in: 'query', schema: { type: 'string', example: 'INR' } }], responses: { 200: ok('Rates keyed by currency code'), 400: err('Unknown base currency') } } },
    '/currency/convert': {
      get: {
        tags: ['currency'], summary: 'Convert an amount between two currencies',
        parameters: [
          { name: 'amount', in: 'query', required: true, schema: { type: 'number', example: 8.5 } },
          { name: 'from', in: 'query', schema: { type: 'string', example: 'EUR' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', example: 'INR' } }
        ],
        responses: { 200: ok('Converted amount with rate and formatted string'), 400: err('Unknown currency or bad amount') }
      },
      post: {
        tags: ['currency'], summary: 'Convert an amount (JSON body)',
        requestBody: jsonBody({ amount: { type: 'number', example: 100 }, from: str('INR'), to: str('AED') }, ['amount', 'to']),
        responses: { 200: ok('Converted amount'), 400: err('Unknown currency or bad amount') }
      }
    },
    // ------------------------------------------------------------ language
    '/language': { get: { tags: ['language'], summary: 'List all supported languages with names, flags and RTL flag', responses: { 200: ok('15 languages incl. EN, FR, HI, AR, JA, ZH') } } },
    '/language/translations': { get: { tags: ['language'], summary: 'Full storefront-chrome translation table for a locale', parameters: [{ name: 'lang', in: 'query', schema: { type: 'string', example: 'fr' } }], responses: { 200: ok('Key/value translation table for the locale'), 400: err('Unknown language') } } },
    '/language/translate': {
      get: {
        tags: ['language'], summary: 'Translate a single UI string key into a target language',
        parameters: [
          { name: 'key', in: 'query', required: true, schema: { type: 'string', example: 'nav.oven' } },
          { name: 'lang', in: 'query', required: true, schema: { type: 'string', example: 'ja' } }
        ],
        responses: { 200: ok('Translated text with RTL flag'), 400: err('Unknown language'), 404: err('Unknown translation key') }
      },
      post: {
        tags: ['language'], summary: 'Translate a single UI string key (JSON body)',
        requestBody: jsonBody({ key: str('hero.kicker'), lang: str('de') }, ['key', 'lang']),
        responses: { 200: ok('Translated text'), 400: err('Unknown language'), 404: err('Unknown translation key') }
      }
    }
  },
  components: {
    schemas: {
      Product: {
        type: 'object',
        properties: {
          id: str('p-1'), name: str('Levain Country Loaf'),
          category: { type: 'string', enum: ['bread', 'viennoiserie', 'patisserie'] },
          price: num(8.5), description: str('48-hour fermented sourdough, dark bake.')
        }
      },
      Schedule: {
        type: 'object',
        properties: {
          date: str('2026-07-10'),
          bakes: { type: 'array', items: { type: 'object', properties: { time: str('06:30'), product: str('Baguette Tradition'), batch: num(40) } } }
        }
      },
      PlatformStatus: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          services: { type: 'object', additionalProperties: { type: 'object', properties: { up: { type: 'boolean' }, latencyMs: { type: 'number' } } } }
        }
      },
      Error: { type: 'object', properties: { error: str('Not found') } }
    }
  }
};

// --- tiny spec helpers --------------------------------------------------
function str(example) { return example === undefined ? { type: 'string' } : { type: 'string', example }; }
function num(example) { return example === undefined ? { type: 'number' } : { type: 'number', example }; }
function pathP(name) { return { name, in: 'path', required: true, schema: { type: 'string' } }; }
function hdr(name, example) { return { name, in: 'header', required: true, schema: { type: 'string', example } }; }
function jsonBody(properties, required) {
  return { required: true, content: { 'application/json': { schema: { type: 'object', properties, ...(required ? { required } : {}) } } } };
}
function ok(description) { return { description, content: { 'application/json': { schema: { type: 'object' } } } }; }
function err(description) { return { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }; }
