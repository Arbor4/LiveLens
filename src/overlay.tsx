import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayView } from "./components/OverlayView";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayView />
  </StrictMode>,
);
