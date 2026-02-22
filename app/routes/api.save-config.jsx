import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }) {
  const { session } = await authenticate.admin(request);

  const body = await request.json();

  const { propertyId, jsonKey } = body;

  await prisma.ga4Config.upsert({
    where: { shop: session.shop },
    update: { propertyId, jsonKey },
    create: {
      shop: session.shop,
      propertyId,
      jsonKey,
    },
  });

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
