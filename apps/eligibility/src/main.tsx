import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/index.css';
import EligibilityApp from './EligibilityApp';
import { readPublicAppCheckToken } from '../../../src/auth/appCheck';
import { setApiSecurityTokenProvider } from '../../../src/shared/api';

setApiSecurityTokenProvider(async () => {
  const token = await readPublicAppCheckToken();
  return token ? { 'X-Firebase-AppCheck': token } : {};
});

document.documentElement.classList.add('eligibility-active');
document.body.classList.add('eligibility-active');

createRoot(document.getElementById('root')!).render(
  <StrictMode><EligibilityApp /></StrictMode>,
);
