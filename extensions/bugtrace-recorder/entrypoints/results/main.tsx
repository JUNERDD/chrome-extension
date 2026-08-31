import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@rrweb/replay/dist/style.css';
import { I18nProvider, loadI18nBootstrap, translateMessage } from '../../src/i18n';
import '../../src/ui/heroui.css';
import { ResultsApp } from './ResultsApp';
import './results.css';

const root = document.getElementById('root');
if (!root) throw new Error('Results root element is missing.');
const reactRoot = createRoot(root);

async function mount(): Promise<void> {
  const { languagePreference, locale } = await loadI18nBootstrap();
  document.documentElement.lang = locale;
  document.title = translateMessage(locale, 'results.pageTitle');
  reactRoot.render(
    <StrictMode>
      <I18nProvider initialLanguagePreference={languagePreference}>
        <ResultsApp />
      </I18nProvider>
    </StrictMode>,
  );
}

void mount();
