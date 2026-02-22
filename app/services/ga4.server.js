import { GoogleAuth } from "google-auth-library";

export async function fetchGA4Analytics({
  propertyId,
  serviceAccountJson,
  startDate = "7daysAgo",
  endDate = "today",
  prevStartDate = "14daysAgo",
  prevEndDate = "7daysAgo"
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
  const url = `https://analyticsdata.googleapis.com/v1beta/${safe}:runReport`;

  // Metric definitions
  const coreMetrics = [
    { name: "screenPageViews" },   // [0]
    { name: "sessions" },          // [1]
    { name: "totalUsers" },        // [2]
    { name: "conversions" },       // [3]
  ];

  // 1. Current period — time series by date (for charts)
  const reqCurrent = client.request({
    url, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: coreMetrics,
      dimensions: [{ name: "date" }],
    },
  });

  // 2. Previous period — totals only (for trend badges)
  const reqPrevious = client.request({
    url, method: "POST",
    data: {
      dateRanges: [{ startDate: prevStartDate, endDate: prevEndDate }],
      metrics: coreMetrics,
    },
  });

  // 3. Top landing pages by sessions (organic search)
  const reqOrganic = client.request({
    url, method: "POST",
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

  // 4. Channel breakdown (traffic sources)
  const reqChannels = client.request({
    url, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8,
    },
  });

  // 5. Top pages by page views
  const reqTopPages = client.request({
    url, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: "screenPageViews" },
        { name: "sessions" },
      ],
      dimensions: [{ name: "pagePath" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 8,
    },
  });

  // 6. Device category breakdown
  const reqDevices = client.request({
    url, method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      dimensions: [{ name: "deviceCategory" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    },
  });

  const [
    resCurrent,
    resPrevious,
    resOrganic,
    resChannels,
    resTopPages,
    resDevices,
  ] = await Promise.all([
    reqCurrent,
    reqPrevious,
    reqOrganic,
    reqChannels,
    reqTopPages,
    reqDevices,
  ]);

  return {
    currentPeriod: resCurrent.data,
    previousPeriod: resPrevious.data,
    organicTraffic: resOrganic.data,
    channels: resChannels.data,
    topPages: resTopPages.data,
    devices: resDevices.data,
  };
}
