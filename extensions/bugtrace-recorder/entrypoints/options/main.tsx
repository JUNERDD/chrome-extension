import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, loadI18nBootstrap, translateMessage } from '../../src/i18n';
import '../../src/ui/heroui.css';
import { OptionsApp } from './OptionsApp';
import './options.css';

const root = document.getElementById('root');
if (!root) throw new Error('Options root element is missing.');
const reactRoot = createRoot(root);

async function mount(): Promise<void> {
  const { languagePreference, locale } = await loadI18nBootstrap();
  document.documentElement.lang = locale;
  document.title = `${translateMessage(locale, 'settings.title')} — ${translateMessage(locale, 'common.appName')}`;
  reactRoot.render(
    <StrictMode>
      <I18nProvider initialLanguagePreference={languagePreference}>
        <OptionsApp />
      </I18nProvider>
    </StrictMode>,
  );
}

void mount();
