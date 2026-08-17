import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupApp } from './PopupApp';
import '../../src/ui/theme.css';
import './popup.css';

const root = document.getElementById('root');
if (!root) throw new Error('Popup root element is missing.');

createRoot(root).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
