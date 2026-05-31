import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CSTD Alpha UI crashed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-crash-shell" role="alert">
        <section className="app-crash-card">
          <p className="eyebrow">CSTD Alpha</p>
          <h1>页面组件异常</h1>
          <p>当前页面渲染失败。请刷新页面重试；如果持续出现，请保留当前操作路径便于排查。</p>
          <button type="button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </section>
      </main>
    );
  }
}
