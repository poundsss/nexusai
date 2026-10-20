import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
// Add page imports here
import Home from '@/pages/Home';
import NexusCode from '@/pages/NexusCode';
import Landing from '@/pages/Landing';
import Pricing from '@/pages/Pricing';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import OAuthConsent from '@/pages/OAuthConsent';
import Projects from '@/pages/Projects';
import Builder from '@/pages/Builder';
import Billing from '@/pages/Billing';
import Settings from '@/pages/Settings';
import Members from '@/pages/Members';
import Analytics from '@/pages/Analytics';
import AppAnalytics from '@/pages/AppAnalytics';
import Logs from '@/pages/Logs';
import Agent from '@/pages/Agent';
import AgentFiles from '@/pages/AgentFiles';
import AgentMemory from '@/pages/AgentMemory';
import AgentData from '@/pages/AgentData';
import AgentSettings from '@/pages/AgentSettings';
import Meetings from '@/pages/Meetings';
import GrowthAgent from '@/pages/GrowthAgent';
import TestingAgent from '@/pages/TestingAgent';
import Notes from '@/pages/Notes';
import Transfers from '@/pages/Transfers';
import ApiAccess from '@/pages/ApiAccess';
import AppMcp from '@/pages/AppMcp';
import Connections from '@/pages/Connections';
import MarketplacePublisher from '@/pages/MarketplacePublisher';
import MarketplaceModeration from '@/pages/MarketplaceModeration';
import MobileAdmin from '@/pages/MobileAdmin';
import Architecture from '@/pages/Architecture';
import Workflows from '@/pages/Workflows';
import Plugins from '@/pages/Plugins';
import Mcp from '@/pages/Mcp';
import Help from '@/pages/Help';
import Admin from '@/pages/Admin';
import Marketplace from '@/pages/Marketplace';
import MarketplaceDetail from '@/pages/MarketplaceDetail';
import AppOAuthCallback from '@/pages/AppOAuthCallback';
import PublicApp from '@/pages/PublicApp';
import Enterprise from '@/pages/enterprise/Enterprise';
import EnterpriseSso from '@/pages/enterprise/EnterpriseSso';
import EnterpriseScim from '@/pages/enterprise/EnterpriseScim';
import EnterpriseGroups from '@/pages/enterprise/EnterpriseGroups';
import EnterpriseRoles from '@/pages/enterprise/EnterpriseRoles';
import EnterpriseDomains from '@/pages/enterprise/EnterpriseDomains';
import EnterpriseSecurity from '@/pages/enterprise/EnterpriseSecurity';
import Compliance from '@/pages/compliance/Compliance';
import ComplianceAbuse from '@/pages/compliance/ComplianceAbuse';
import ComplianceAudit from '@/pages/compliance/ComplianceAudit';
import ComplianceBreaches from '@/pages/compliance/ComplianceBreaches';
import ComplianceLegal from '@/pages/compliance/ComplianceLegal';
import CompliancePrivacy from '@/pages/compliance/CompliancePrivacy';
import ComplianceRetention from '@/pages/compliance/ComplianceRetention';
import AppShell from '@/components/shell/AppShell';
import ProtectedRoute from '@/components/ProtectedRoute';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/landing" element={<Landing />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/oauth/consent" element={<OAuthConsent />} />
      <Route path="/app/:slug" element={<PublicApp />} />
      <Route path="/app/:slug/*" element={<PublicApp />} />
      <Route path="/oauth/callback" element={<AppOAuthCallback />} />
      <Route path="/app/:slug/oauth/callback" element={<AppOAuthCallback />} />
      <Route path="/~app/oauth/callback" element={<AppOAuthCallback />} />

      {/* Authenticated app with shared shell */}
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/builder/:projectId" element={<Builder />} />
          <Route path="/projects/:projectId" element={<Builder />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/members" element={<Members />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/apps/:appId/analytics" element={<AppAnalytics />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/agent/files" element={<AgentFiles />} />
          <Route path="/agent/memory" element={<AgentMemory />} />
          <Route path="/agent/data" element={<AgentData />} />
          <Route path="/agent/settings" element={<AgentSettings />} />
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/growth-agent" element={<GrowthAgent />} />
          <Route path="/nexus-code" element={<NexusCode />} />
          <Route path="/testing-agent" element={<TestingAgent />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/api-access" element={<ApiAccess />} />
          <Route path="/app-mcp" element={<AppMcp />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/publisher" element={<MarketplacePublisher />} />
          <Route path="/marketplace/moderation" element={<MarketplaceModeration />} />
          <Route path="/mobile-admin" element={<MobileAdmin />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/plugins" element={<Plugins />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/help" element={<Help />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/marketplace" element={<Marketplace />} />
          <Route path="/marketplace/:slug" element={<MarketplaceDetail />} />
          <Route path="/enterprise" element={<Enterprise />} />
          <Route path="/enterprise/sso" element={<EnterpriseSso />} />
          <Route path="/enterprise/scim" element={<EnterpriseScim />} />
          <Route path="/enterprise/groups" element={<EnterpriseGroups />} />
          <Route path="/enterprise/roles" element={<EnterpriseRoles />} />
          <Route path="/enterprise/domains" element={<EnterpriseDomains />} />
          <Route path="/enterprise/security" element={<EnterpriseSecurity />} />
          <Route path="/compliance" element={<Compliance />} />
          <Route path="/compliance/abuse" element={<ComplianceAbuse />} />
          <Route path="/compliance/audit" element={<ComplianceAudit />} />
          <Route path="/compliance/breaches" element={<ComplianceBreaches />} />
          <Route path="/compliance/legal" element={<ComplianceLegal />} />
          <Route path="/compliance/privacy" element={<CompliancePrivacy />} />
          <Route path="/compliance/retention" element={<ComplianceRetention />} />
        </Route>
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
        <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </AuthProvider>
  )
}

export default App