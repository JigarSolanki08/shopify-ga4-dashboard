import { useState, useMemo, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchGA4Analytics } from "../services/ga4.server";
import { useLoaderData, useNavigation, Form, useSubmit } from "react-router";
import { Page, Card, Text, Button, TextField, Layout, BlockStack, InlineStack, Box, Icon, Badge, Select } from "@shopify/polaris";
import { ViewIcon, ArrowDownIcon, ArrowUpIcon, PlusIcon as ClickIcon, StarIcon as TargetIcon, ViewIcon as CashDollarIcon } from "@shopify/polaris-icons";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await prisma.ga4Config.findUnique({
    where: { shop },
  });

  if (!config) {
    return Response.json({ configured: false, data: null });
  }

  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") || "7days";

    let startDate, endDate, prevStartDate, prevEndDate;
    const today = new Date();

    if (period === "today") {
      startDate = "today";
      endDate = "today";
      prevStartDate = "yesterday";
      prevEndDate = "yesterday";
    } else if (period === "30days") {
      startDate = "30daysAgo";
      endDate = "today";
      prevStartDate = "60daysAgo";
      prevEndDate = "31daysAgo";
    } else {
      // default 7 days
      startDate = "7daysAgo";
      endDate = "today";
      prevStartDate = "14daysAgo";
      prevEndDate = "8daysAgo";
    }

    const data = await fetchGA4Analytics({
      propertyId: config.propertyId,
      serviceAccountJson: config.jsonKey,
      startDate,
      endDate,
      prevStartDate,
      prevEndDate
    });
    return Response.json({ configured: true, data, period });
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    return Response.json({
      configured: true,
      data: null,
      error: error.message || error.toString() || "Failed to fetch analytics"
    });
  }
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const propertyId = formData.get("propertyId");
  const fileField = formData.get("jsonFile");

  if (!propertyId || !fileField) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }

  const jsonKey = await fileField.text();

  await prisma.ga4Config.upsert({
    where: { shop: session.shop },
    update: { propertyId, jsonKey },
    create: {
      shop: session.shop,
      propertyId,
      jsonKey,
    },
  });

  return Response.json({ success: true });
}

// Helper to format large numbers to K/M
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num;
}

function calculateTrend(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return (((current - previous) / previous) * 100).toFixed(1);
}

function processMetrics(data) {
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let prevImpressions = 0;
  let prevClicks = 0;
  let prevConversions = 0;
  const chartData = [];

  const currentData = data?.currentPeriod;
  const previousData = data?.previousPeriod;
  const organicData = data?.organicTraffic;

  if (currentData && currentData.rows) {
    currentData.rows.forEach(row => {
      const imp = parseInt(row.metricValues[0].value, 10) || 0;
      const clk = parseInt(row.metricValues[1].value, 10) || 0;
      const conv = parseInt(row.metricValues[3].value, 10) || 0;

      impressions += imp;
      clicks += clk;
      conversions += conv;

      const dateStr = row.dimensionValues ? row.dimensionValues[0].value : "";
      const formattedDate = dateStr ? `${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}` : "Unknown";

      chartData.push({ date: formattedDate, impressions: imp, clicks: clk, conversions: conv });
    });
    chartData.sort((a, b) => a.date.localeCompare(b.date));
  }

  if (previousData && previousData.rows) {
    // There shouldn't be a date dimension, just scalar totals since we omitted it in `fetchGA4`
    previousData.rows.forEach(row => {
      prevImpressions += parseInt(row.metricValues[0].value, 10) || 0;
      prevClicks += parseInt(row.metricValues[1].value, 10) || 0;
      prevConversions += parseInt(row.metricValues[3].value, 10) || 0;
    });
  }

  const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) + "%" : "0%";
  const prevCtrNum = prevImpressions > 0 ? (prevClicks / prevImpressions) * 100 : 0;
  const currentCtrNum = impressions > 0 ? (clicks / impressions) * 100 : 0;

  // Process top organic landing pages to act as Brand Search Keywords
  let topKeywords = [];
  if (organicData && organicData.rows) {
    topKeywords = organicData.rows.map(row => {
      const fullPath = row.dimensionValues[1].value; // landing page + query
      // Extract something meaningful, often people search and hit index or specific product
      let keyword = fullPath.length > 30 ? fullPath.substring(0, 30) + '...' : fullPath;
      if (keyword === "/" || keyword === "(not set)") keyword = "Organic Homepage Traffic";
      return {
        keyword: keyword,
        volume: parseInt(row.metricValues[0].value, 10) || 0
      }
    });
  }

  return {
    impressions,
    clicks,
    ctr,
    conversions,
    chartData,
    topKeywords,
    trends: {
      impressions: calculateTrend(impressions, prevImpressions),
      clicks: calculateTrend(clicks, prevClicks),
      ctr: calculateTrend(currentCtrNum, prevCtrNum),
      conversions: calculateTrend(conversions, prevConversions),
    }
  };
}

function DemandCreationCard({ metrics }) {
  const getTrendBadge = (value) => {
    const isPositive = value >= 0;
    const tone = isPositive ? "success" : "critical";
    const IconComponent = isPositive ? ArrowUpIcon : ArrowDownIcon;
    return (
      <div style={{ background: isPositive ? '#d1fae5' : '#fee2e2', padding: '4px 8px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '4px', color: isPositive ? '#059669' : '#ef4444' }}>
        <Icon source={IconComponent} tone={tone} />
        <span style={{ fontSize: '12px', fontWeight: 'bold' }}>{Math.abs(value)}%</span>
      </div>
    );
  };

  return (
    <Box paddingBlockStart="400">
      <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '24px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', border: '1px solid #e5e7eb' }}>
        <BlockStack gap="400">
          <InlineStack align="start" blockAlign="center" gap="200">
            <div style={{ background: '#e0e7ff', padding: '6px', borderRadius: '50%' }}>
              <Icon source={ViewIcon} tone="interactive" />
            </div>
            <div>
              <Text variant="headingMd" as="h2">Demand Creation</Text>
              <Text variant="bodySm" tone="subdued">Traffic and engagement metrics from paid channels</Text>
            </div>
          </InlineStack>

          <BlockStack gap="300">
            {/* Impressions */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', padding: '12px 16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingBottom: '4px' }}>
                <div style={{ background: '#3b82f6', width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px', color: 'white', flexShrink: 0 }}>
                  <Icon source={ViewIcon} />
                </div>
                <div style={{ flex: 1, minWidth: '100px' }}>
                  <Text variant="bodySm">Impressions</Text>
                  <Text variant="headingLg" fontWeight="bold">{formatNumber(metrics.impressions)}</Text>
                </div>
              </div>
              {getTrendBadge(metrics.trends.impressions)}
            </div>

            {/* Clicks */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', padding: '12px 16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingBottom: '4px' }}>
                <div style={{ background: '#a855f7', width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px', color: 'white', flexShrink: 0 }}>
                  <Icon source={ClickIcon} />
                </div>
                <div style={{ flex: 1, minWidth: '100px' }}>
                  <Text variant="bodySm">Clicks</Text>
                  <Text variant="headingLg" fontWeight="bold">{formatNumber(metrics.clicks)}</Text>
                </div>
              </div>
              {getTrendBadge(metrics.trends.clicks)}
            </div>

            {/* CTR */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', padding: '12px 16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingBottom: '4px' }}>
                <div style={{ background: '#6366f1', width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px', color: 'white', flexShrink: 0 }}>
                  <Icon source={TargetIcon} />
                </div>
                <div style={{ flex: 1, minWidth: '100px' }}>
                  <Text variant="bodySm">CTR</Text>
                  <Text variant="headingLg" fontWeight="bold">{metrics.ctr}</Text>
                </div>
              </div>
              {getTrendBadge(metrics.trends.ctr)}
            </div>

            {/* Conversions */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', padding: '12px 16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingBottom: '4px' }}>
                <div style={{ background: '#10b981', width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px', color: 'white', flexShrink: 0 }}>
                  <Icon source={CashDollarIcon} />
                </div>
                <div style={{ flex: 1, minWidth: '100px' }}>
                  <Text variant="bodySm">Conversions</Text>
                  <Text variant="headingLg" fontWeight="bold">{formatNumber(metrics.conversions)}</Text>
                </div>
              </div>
              {getTrendBadge(metrics.trends.conversions)}
            </div>
          </BlockStack>
        </BlockStack>
      </div>
    </Box>
  );
}

function BrandSearchKeywordsCard({ metrics }) {
  const keywords = metrics.topKeywords || [];

  return (
    <Box paddingBlockStart="400">
      <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '24px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', border: '1px solid #e5e7eb' }}>
        <InlineStack align="start" blockAlign="center" gap="200" wrap={false}>
          <Text variant="headingMd" as="h2" fontWeight="bold">Top Organic Traffic Sources</Text>
          <Text variant="bodySm" tone="subdued">via GA4 Channels</Text>
        </InlineStack>

        <div style={{ marginTop: '20px', borderRadius: '8px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ minWidth: '100%', display: 'table', width: '100%' }}>
            <div style={{ display: 'table-row', backgroundColor: '#f9fafb', fontSize: '13px', color: '#6b7280' }}>
              <div style={{ display: 'table-cell', padding: '12px 16px', fontWeight: 'bold' }}>#</div>
              <div style={{ display: 'table-cell', padding: '12px 16px', fontWeight: 'bold' }}>Landing Page Track</div>
              <div style={{ display: 'table-cell', padding: '12px 16px', fontWeight: 'bold', textAlign: 'right' }}>Sessions</div>
            </div>

            {keywords.length > 0 ? keywords.map((kw, index) => (
              <div key={index} style={{ display: 'table-row', borderBottom: '1px solid #f3f4f6', fontSize: '14px' }}>
                <div style={{ display: 'table-cell', padding: '16px', fontWeight: 'bold', verticalAlign: 'middle', borderBottom: '1px solid #f3f4f6' }}>{index + 1}</div>
                <div style={{ display: 'table-cell', padding: '16px', fontWeight: '500', verticalAlign: 'middle', borderBottom: '1px solid #f3f4f6', wordBreak: 'break-all' }}>{kw.keyword}</div>
                <div style={{ display: 'table-cell', padding: '16px', textAlign: 'right', verticalAlign: 'middle', borderBottom: '1px solid #f3f4f6' }}>{kw.volume}</div>
              </div>
            )) : (
              <div style={{ padding: '16px', textAlign: 'center', color: '#6b7280', width: '100%' }}>
                No organic search volume detected for this period.
              </div>
            )}
          </div>
        </div>
      </div>
    </Box>
  );
}

function TrafficChartCard({ metrics }) {
  return (
    <Box paddingBlockStart="400">
      <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '24px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', border: '1px solid #e5e7eb' }}>
        <Text variant="headingMd" as="h2" fontWeight="bold">Traffic Overview</Text>
        <div style={{ height: '350px', width: '100%', minHeight: '350px', marginTop: '20px' }}>
          {metrics.chartData && metrics.chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={metrics.chartData} margin={{ top: 20, right: 30, bottom: 20, left: 0 }}>
                <Line type="monotone" dataKey="impressions" stroke="#3b82f6" strokeWidth={3} name="Views" dot={{ r: 4 }} activeDot={{ r: 8 }} />
                <Line type="monotone" dataKey="clicks" stroke="#a855f7" strokeWidth={3} name="Sessions" dot={{ r: 4 }} activeDot={{ r: 8 }} />
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} padding={{ left: 20, right: 20 }} />
                <YAxis tickLine={false} axisLine={false} width={60} />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', padding: '12px' }}
                  cursor={{ stroke: '#e5e7eb', strokeWidth: 2 }}
                />
                <Legend iconType="circle" wrapperStyle={{ paddingTop: '20px', paddingBottom: '10px' }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <BlockStack align="center" inlineAlign="center">
              <Text tone="subdued">No traffic data available to chart.</Text>
            </BlockStack>
          )}
        </div>
      </div>
    </Box>
  );
}

export default function Dashboard() {
  const { configured, data, error, period } = useLoaderData() || {};
  const navigation = useNavigation();
  const submit = useSubmit();

  const [propertyId, setPropertyId] = useState("");
  const saving = navigation.state === "submitting";
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  const metrics = useMemo(() => processMetrics(data), [data]);

  const handlePeriodChange = useCallback((value) => {
    submit({ period: value }, { method: "get", action: "?index" });
  }, [submit]);

  if (!configured) {
    return (
      <Page title="Setup Required">
        <Card sectioned>
          <Text variant="headingMd" as="h2">Connect Google Analytics</Text>
          <Form method="post" encType="multipart/form-data">
            <div style={{ marginTop: 16 }}>
              <p style={{ marginBottom: 12 }}>Please add your GA4 Property ID and Service Account JSON key.</p>
              <TextField label="GA4 Property ID" name="propertyId" value={propertyId} onChange={setPropertyId} autoComplete="off" />
            </div>
            <div style={{ marginTop: 16 }}>
              <input type="file" name="jsonFile" accept=".json" required />
            </div>
            <div style={{ marginTop: 16 }}>
              <Button submit variant="primary" loading={saving}>Save and Connect</Button>
            </div>
          </Form>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
          <Text variant="headingXl" as="h1" fontWeight="bold">Analytics Overview</Text>
          <div style={{ width: '50%', maxWidth: '250px' }}>
            <Form method="get" action="?index">
              <Select
                name="period"
                label="Date range"
                labelHidden
                options={[
                  { label: 'Today', value: 'today' },
                  { label: 'Last 7 days', value: '7days' },
                  { label: 'Last 30 days', value: '30days' },
                ]}
                onChange={handlePeriodChange}
                value={period || "7days"}
                disabled={isLoading}
              />
            </Form>
          </div>
        </div>
      </div>

      {error ? (
        <Box paddingBlockEnd="400">
          <Card sectioned><Text tone="critical">Failed to fetch analytics: {error}</Text></Card>
        </Box>
      ) : isLoading ? (
        <Card sectioned><Text as="p">Loading analytics data...</Text></Card>
      ) : data ? (
        <Layout>
          <Layout.Section>
            <DemandCreationCard metrics={metrics} />
          </Layout.Section>
          <Layout.Section>
            <div style={{ marginTop: '16px' }}>
              <BrandSearchKeywordsCard metrics={metrics} />
            </div>
          </Layout.Section>
          <Layout.Section>
            <div style={{ marginTop: '16px' }}>
              <TrafficChartCard metrics={metrics} />
            </div>
          </Layout.Section>
        </Layout>
      ) : null}
    </Page>
  );
}
