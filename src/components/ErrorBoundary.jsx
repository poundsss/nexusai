import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

// Catches uncaught render errors anywhere in the app and shows a recoverable
// error screen instead of a blank white page. Without this, a single undefined
// access in any page crashes the entire application.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Log to console for debugging; the platform's observability captures this too.
    console.error("Unhandled render error:", error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    // A full reload clears any corrupted in-memory state that may have caused the crash.
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
          <span className="h-12 w-12 mx-auto rounded-full bg-destructive/10 text-destructive grid place-items-center">
            <AlertTriangle className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-lg font-semibold">Something went wrong</h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
            An unexpected error occurred while rendering this page. Reloading usually fixes it.
          </p>
          <button
            onClick={this.handleReload}
            className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-2 text-[13px] font-medium hover:bg-primary/90 transition-colors"
          >
            <RotateCcw className="h-4 w-4" /> Reload page
          </button>
        </div>
      </div>
    );
  }
}