import React from "react";
import { createRoot } from "react-dom/client";
import "cockpit-dark-theme";
import App from "./app";

import "patternfly/patternfly-6-cockpit.scss";
import './app.scss';

const container = document.getElementById("app");
if (!container) {
  throw new Error('Root element with id "app" not found');
}
const root = createRoot(container);
root.render(<App />);

