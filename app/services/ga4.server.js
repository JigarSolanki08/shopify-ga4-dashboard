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
  const safePropertyId = propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
  const url = `https://analyticsdata.googleapis.com/v1beta/${safePropertyId}:runReport`;

  const commonMetrics = [
    { name: "screenPageViews" },
    { name: "sessions" },
    { name: "totalUsers" },
    { name: "conversions" },
  ];

  // Request 1: Current Period Time-Series (For the line chart and current totals)
  const reqCurrent = client.request({
    url,
    method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }],
      metrics: commonMetrics,
      dimensions: [{ name: "date" }],
    },
  });

  // Request 2: Previous Period Totals (For percentage trend calculations)
  const reqPrevious = client.request({
    url,
    method: "POST",
    data: {
      dateRanges: [{ startDate: prevStartDate, endDate: prevEndDate }],
      metrics: commonMetrics,
      // No date dimension here to get a single aggregated row of totals
    },
  });

  // Request 3: Organic SEO / Landing Pages (Fallback for Brand Search Keywords)
  const reqOrganic = client.request({
    url,
    method: "POST",
    data: {
      dateRanges: [{ startDate, endDate }, { startDate: prevStartDate, endDate: prevEndDate }],
      metrics: [{ name: "sessions" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "landingPagePlusQueryString" }],
      dimensionFilter: {
        filter: {
          fieldName: "sessionDefaultChannelGroup",
          stringFilter: {
            matchType: "EXACT",
            value: "Organic Search"
          }
        }
      },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 6
    },
  });

  const [resCurrent, resPrevious, resOrganic] = await Promise.all([reqCurrent, reqPrevious, reqOrganic]);

  return {
    currentPeriod: resCurrent.data,
    previousPeriod: resPrevious.data,
    organicTraffic: resOrganic.data,
  };
}
