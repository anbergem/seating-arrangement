import { Navigate } from "react-router";

// There is no marketing page: every route requires sign-in (D11), so the root is
// only the way in to the jobs list (B17).
//
// A client navigation rather than `redirect("/jobs")` from a loader: the
// Cloudflare build renders `/` through the React Router handler to produce
// `dist/index.html`, and a redirecting root makes that render return no HTML, so
// the build falls back to a generated shell. See docs/plan/DISCREPANCIES.md.
export default function IndexRoute() {
  return <Navigate to="/jobs" replace />;
}
