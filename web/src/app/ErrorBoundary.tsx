import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertBox } from "../components/ui/AlertBox";

interface State {
  error: Error | null;
}

/**
 * Render-crash guard (layer 4). Never lets a white screen reach the user —
 * always shows a recoverable AlertBox instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Bond] render error", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{ maxWidth: 560, margin: "96px auto", padding: "0 20px" }}>
        <AlertBox
          variant="error"
          title="Something went wrong in the interface"
          description="This is a UI error, not a transaction — no funds were affected. Reloading usually fixes it."
          details={`${this.state.error.name}: ${this.state.error.message}`}
          action={{ label: "Reload the page", onClick: () => window.location.reload() }}
          secondaryAction={{ label: "Try again", onClick: this.reset }}
        />
      </div>
    );
  }
}
