import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MirrorView } from "./components/MirrorView";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MirrorView />
  </StrictMode>,
);
