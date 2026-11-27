import React from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { I18nProvider } from "./context/I18nContext";
import { Layout } from "./components/layout/Layout";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { LegalPage } from "./pages/LegalPage";

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Router>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/privacy" element={<LegalPage kind="privacy" />} />
            <Route path="/terms" element={<LegalPage kind="terms" />} />
            <Route element={<Layout />}>
              <Route path="dashboard" element={null} />
              <Route path="map" element={null} />
              <Route path="nodes" element={null} />
              <Route path="inventory" element={<Navigate to="/nodes?filter=inventory" replace />} />
              <Route path="flasher" element={null} />
              <Route path="firmware" element={null} />
              <Route path="users" element={null} />
              <Route path="farm-assistant" element={null} />
            </Route>
            <Route path="manufacturing" element={<Navigate to="/flasher" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </I18nProvider>
    </ThemeProvider>
  );
};

export default App;
