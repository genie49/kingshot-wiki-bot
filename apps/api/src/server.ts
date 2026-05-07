import { serve } from "@hono/node-server";
import app from "./app.js";
import { config } from "./config.js";

serve(
  {
    fetch: app.fetch,
    hostname: "0.0.0.0",
    port: config.PORT
  },
  (info) => {
    console.log(`Kingshot Wiki Bot API listening on http://${info.address}:${info.port}`);
  }
);
