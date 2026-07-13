import { lazy } from "react";

export const AdminHomePage = lazy(async () => {
  const module = await import("./AdminHomePage");
  return { default: module.AdminHomePage };
});

export const KnowledgeBaseDetailPage = lazy(async () => {
  const module = await import("./KnowledgeBaseDetailPage");
  return { default: module.KnowledgeBaseDetailPage };
});

export const LoginPage = lazy(async () => {
  const module = await import("./LoginPage");
  return { default: module.LoginPage };
});

export const SettingsPage = lazy(async () => {
  const module = await import("./SettingsPage");
  return { default: module.SettingsPage };
});
