import type { ComponentProps } from "react";
import { KeyRoundIcon, LibraryIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { AdminSidebarHeader } from "@/components/admin-sidebar-header";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar
} from "@/components/ui/sidebar";

export type HomeSection = "knowledge-bases" | "openapi-keys" | "settings";

type HomeSidebarProps = ComponentProps<typeof Sidebar> & {
  appName: string;
  activeSection: HomeSection;
  labels: {
    navigation: string;
    toggleSidebarRail: string;
    knowledgeBases: string;
    openApiKeys: string;
    settings: string;
    logout: string;
  };
  onSectionSelect: (section: HomeSection) => void;
  onLogout: () => void;
};

export function HomeSidebar({
  appName,
  activeSection,
  labels,
  onSectionSelect,
  onLogout,
  ...props
}: HomeSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  function handleSelect(section: HomeSection) {
    onSectionSelect(section);
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <AdminSidebarHeader appName={appName} />
      <SidebarContent className="pt-4">
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label={labels.navigation}>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    type="button"
                    isActive={activeSection === "knowledge-bases"}
                    aria-current={activeSection === "knowledge-bases" ? "page" : undefined}
                    tooltip={labels.knowledgeBases}
                    onClick={() => handleSelect("knowledge-bases")}
                  >
                    <LibraryIcon />
                    <span>{labels.knowledgeBases}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    type="button"
                    isActive={activeSection === "openapi-keys"}
                    aria-current={activeSection === "openapi-keys" ? "page" : undefined}
                    tooltip={labels.openApiKeys}
                    onClick={() => handleSelect("openapi-keys")}
                  >
                    <KeyRoundIcon />
                    <span>{labels.openApiKeys}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    type="button"
                    isActive={activeSection === "settings"}
                    aria-current={activeSection === "settings" ? "page" : undefined}
                    tooltip={labels.settings}
                    onClick={() => handleSelect("settings")}
                  >
                    <SettingsIcon />
                    <span>{labels.settings}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Button type="button" variant="ghost" className="w-full justify-start" onClick={onLogout}>
          <LogOutIcon data-icon="inline-start" />
          {labels.logout}
        </Button>
      </SidebarFooter>
      <SidebarRail aria-label={labels.toggleSidebarRail} />
    </Sidebar>
  );
}
