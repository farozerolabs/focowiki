import DefaultTheme from "vitepress/theme";
import SwaggerApiExplorer from "./components/SwaggerApiExplorer.vue";
import "./swagger-api-explorer.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("SwaggerApiExplorer", SwaggerApiExplorer);
  }
};
