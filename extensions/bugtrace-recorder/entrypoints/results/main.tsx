import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@rrweb/replay/dist/style.css';
import { ResultsApp } from './ResultsApp';
import '../../src/ui/theme.css';
import './results.css';

const root = document.getElementById('root');
if (!root) throw new Error('Results root element is missing.');

createRoot(root).render(
  <StrictMode>
    <ResultsApp />
  </StrictMode>,
);
