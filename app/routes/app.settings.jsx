import { useState } from "react";
import { Page, Card, TextField, Button, Text } from "@shopify/polaris";
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  await authenticate.admin(request);
  return null;
}

export default function Settings() {
  const [propertyId, setPropertyId] = useState("");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  async function handleSave() {
    if (!propertyId || !file) {
      alert("Property ID and JSON required");
      return;
    }

    setSaving(true);

    try {
      const fileReader = new FileReader();
      fileReader.onload = async (e) => {
        const jsonKey = e.target.result;

        const response = await shopify.fetch("/api/save-config", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ propertyId, jsonKey }),
        });

        if (response.ok) {
          navigate("/app");
        } else {
          alert("Failed to save configuration");
        }
        setSaving(false);
      };

      fileReader.readAsText(file);
    } catch (err) {
      console.error(err);
      alert("Error reading file");
      setSaving(false);
    }
  }

  return (
    <Page title="GA4 Settings">
      <Card sectioned>
        <Text variant="headingMd" as="h2">
          Connect Google Analytics
        </Text>

        <TextField
          label="GA4 Property ID"
          value={propertyId}
          onChange={setPropertyId}
          autoComplete="off"
        />

        <div style={{ marginTop: 16 }}>
          <input
            type="file"
            accept=".json"
            onChange={(e) => setFile(e.target.files[0])}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Save
          </Button>
        </div>
      </Card>
    </Page>
  );
}
