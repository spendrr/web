import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorCircleIcon } from "./BannerIcons";
import { translate } from "../lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in wallet UI", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="centered-screen">
          <h1>{translate("Něco se pokazilo")}</h1>
          <p className="muted">
            {translate(
              "Aplikace narazila na neočekávanou chybu. Tvůj seed phrase je bezpečně uložený — zkus stránku načíst znovu.",
            )}
          </p>
          <div className="banner banner-danger">
            <ErrorCircleIcon />
            <span>{this.state.error.message}</span>
          </div>
          <button onClick={() => window.location.reload()}>{translate("Načíst znovu")}</button>
        </div>
      );
    }
    return this.props.children;
  }
}
