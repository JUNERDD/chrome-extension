import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp';
import '../../src/ui/theme.css';
import './options.css';

const root = document.getElementById('root');
if (!root) throw new Error('Options root element is missing.');

createRoot(root).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
