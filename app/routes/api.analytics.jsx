import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { fetchGA4Analytics } from "../services/ga4.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await prisma.ga4Config.findUnique({
    where: { shop },
  });

  if (!config) {
    return new Response(JSON.stringify({ error: "GA4 not configured" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = await fetchGA4Analytics({
    propertyId: config.propertyId,
    serviceAccountJson: config.jsonKey,
  });

  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
