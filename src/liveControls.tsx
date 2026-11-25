import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LiveControlsView } from "./components/LiveControlsView";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LiveControlsView />
  </StrictMode>,
);
