import "@shopify/polaris/build/esm/styles.css";
import { AppProvider } from "@shopify/polaris";
import { Outlet } from "react-router-dom";

export default function App() {
  return (
    <AppProvider>
      <Outlet />
    </AppProvider>
  );
}
