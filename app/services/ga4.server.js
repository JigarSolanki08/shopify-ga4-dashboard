import { GoogleAuth } from "google-auth-library";

export async function fetchGA4Analytics({
  propertyId,
  serviceAccountJson,
  startDate = "7daysAgo",
  endDate = "today",
  prevStartDate = "14daysAgo",
  prevEndDate = "7daysAgo",
}) {
  if (!propertyId || !serviceAccountJson) {
    throw new Error("GA4 not configured");
  }

  const credentials = JSON.parse(serviceAccountJson);
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });

  const client = await auth.getClient();
  const safe = propertyId.startsWith("properties/")
    ? propertyId
    : `properties/${propertyId}`;
  const apiUrl = `https://analyticsdata.googleapis.com/v1beta/${safe}:runReport`;

  // Same 8 metrics as the Flutter app
  const coreMetrics = [
    { name: "activeUsers" },       // [0]
    { name: "sessions" },          // [1]
    { name: "newUsers" },          // [2]
    { name: "screenPageViews" },   // [3]
    { name: "bounceRate" },        // [4]
    { name: "eventCount" },        // [5]
    { name: "purchaseRevenue" },   // [6]
    { name: "totalPurchasers" },   // [7]
  ];

  // 1. Current period — time series (charts)
  const reqCurrent = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: coreMetrics,
      dimensions: [{ name: "date" }],
    },
  });

  // 2. Previous period — totals for trend % badges
  const reqPrevious = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate: prevStartDate, endDate: prevEndDate }],
      metrics: coreMetrics,
    },
  });

  // 3. Traffic channels (session source)
  const reqChannels = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8,
    },
  });

  // 4. Top pages by page views
  const reqTopPages = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "screenPageViews" }, { name: "sessions" }],
      dimensions: [{ name: "pagePath" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 8,
    },
  });

  // 5. Device category
  const reqDevices = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      dimensions: [{ name: "deviceCategory" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    },
  });

  // 6. Product purchase data — same as Flutter's getProductPurchaseData()
  const reqProducts = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: "itemRevenue" },           // Revenue per product
        { name: "itemsPurchased" },   // Quantity sold
      ],
      dimensions: [
        { name: "itemName" },
        { name: "itemId" },
        { name: "itemCategory" },
      ],
      orderBys: [{ metric: { metricName: "itemsPurchased" }, desc: true }],
      limit: 50,
    },
  });

  // 7. Organic landing pages
  const reqOrganic = client.request({
    url: apiUrl, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }],
      dimensions: [
        { name: "sessionDefaultChannelGroup" },
        { name: "landingPagePlusQueryString" },
      ],
      dimensionFilter: {
        filter: {
          fieldName: "sessionDefaultChannelGroup",
          stringFilter: { matchType: "EXACT", value: "Organic Search" },
        },
      },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8,
    },
  });

  const [
    resCurrent, resPrevious, resChannels,
    resTopPages, resDevices, resProducts, resOrganic,
  ] = await Promise.all([
    reqCurrent, reqPrevious, reqChannels,
    reqTopPages, reqDevices, reqProducts, reqOrganic,
  ]);

  return {
    currentPeriod: resCurrent.data,
    previousPeriod: resPrevious.data,
    channels: resChannels.data,
    topPages: resTopPages.data,
    devices: resDevices.data,
    products: resProducts.data,
    organicTraffic: resOrganic.data,
  };
}
