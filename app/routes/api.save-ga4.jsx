import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const { propertyId, serviceJson } = await request.json();

  await prisma.shopAnalyticsConfig.upsert({
    where: { shop },
    update: { propertyId, serviceJson },
    create: { shop, propertyId, serviceJson },
  });

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
