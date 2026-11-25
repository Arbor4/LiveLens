import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CaptureView } from "./components/CaptureView";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CaptureView />
  </StrictMode>,
);
