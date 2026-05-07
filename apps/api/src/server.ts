import { serve } from "@hono/node-server";
import app from "./app.js";
import { config } from "./config.js";

serve(
  {
    fetch: app.fetch,
    port: config.PORT
  },
  (info) => {
    console.log(`Kingshot Wiki Bot API listening on http://localhost:${info.port}`);
  }
);
