import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadDemoWorld } from './demo';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('o elemento #root nao existe no index.html');
}

// Fora do Electron e so em dev, `?demo` enche o escritorio sem agente real.
void loadDemoWorld();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
