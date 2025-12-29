import Stripe from 'stripe';
import sanityClient from '../lib/client';

// Use server-only environment variable for security
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not defined in environment variables');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Fetch product data from Sanity to validate prices on server
async function getProductData(productId) {
  try {
    const product = await sanityClient.fetch(`*[_id == "${productId}"][0]`);
    return product;
  } catch (error) {
    console.error(`Error fetching product ${productId}:`, error);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      // req.body now contains only product IDs and quantities
      const cartItems = req.body;

      if (!Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ error: 'Cart items are required' });
      }

      // Read shipping rate from env so it's easy to change between accounts/modes
      const shippingRate = process.env.STRIPE_SHIPPING_RATE || null;

      // Fetch product data from Sanity on the server to validate prices
      const lineItems = await Promise.all(
        cartItems.map(async (item) => {
          const product = await getProductData(item._id);

          if (!product) {
            throw new Error(`Product with ID ${item._id} not found`);
          }

          // Use price from Sanity, not from client
          const price = product.price;
          if (typeof price !== 'number' || price <= 0) {
            throw new Error(`Invalid price for product ${item._id}`);
          }

          const img = product.image && product.image[0] && product.image[0].asset
            ? product.image[0].asset._ref
            : null;
          const newImage = img
            ? img.replace('image-', 'https://cdn.sanity.io/images/vfxfwnaw/production/').replace('-webp', '.webp')
            : null;

          return {
            price_data: {
              currency: 'usd',
              product_data: {
                name: product.name,
                ...(newImage ? { images: [newImage] } : {}),
              },
              unit_amount: Math.round(price * 100), // Ensure integer amount
            },
            adjustable_quantity: {
              enabled: true,
              minimum: 1,
            },
            quantity: item.quantity,
          };
        })
      );

      const params = {
        submit_type: 'pay',
        mode: 'payment',
        payment_method_types: ['card'],
        billing_address_collection: 'auto',
        // Include shipping options only when a shipping rate id is configured
        ...(shippingRate ? { shipping_options: [{ shipping_rate: shippingRate }] } : {}),
        line_items: lineItems,
        success_url: `${req.headers.origin}/success`,
        cancel_url: `${req.headers.origin}/canceled`,
      };

      // Create Checkout Sessions from body params.
      const session = await stripe.checkout.sessions.create(params);

      res.status(200).json(session);
    } catch (err) {
      console.error('Stripe checkout error:', err);
      const status = err.statusCode || 500;
      const message = err.message || 'Internal Server Error';
      res.status(status).json({ error: message });
    }
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
}