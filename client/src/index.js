import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import SupplierApp from './supplier/SupplierApp';

// Path-based split (no router): /supplier* mounts the off-Zoho supplier platform;
// everything else is the existing nesting/take-off app. Both are served the same
// index.html by Express, so the choice happens here at mount time.
const isSupplier = window.location.pathname.replace(/\/+$/, '').endsWith('/supplier')
  || window.location.pathname.startsWith('/supplier');

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(isSupplier ? <SupplierApp /> : <App />);
