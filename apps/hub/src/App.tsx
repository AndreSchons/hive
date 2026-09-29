import { useEffect } from 'react';
import { isInsideApp } from './ipc/bridge';
import { AgentSetup } from './screens/AgentSetup';
import { Hub } from './screens/Hub';
import { ProjectPicker } from './screens/ProjectPicker';
import { useHub } from './state/world-store';

export function App() {
  const project = useHub((state) => state.project);
  const subscribe = useHub((state) => state.subscribe);
  const loadRoles = useHub((state) => state.loadRoles);
  const setup = useHub((state) => state.setup);

  // Assina os eventos uma vez, para a vida inteira da janela: trocar de projeto
  // nao pode derrubar a assinatura no meio de uma execucao.
  useEffect(() => subscribe(), [subscribe]);

  // Os papeis sao configuracao, e a fila precisa deles para oferecer donos.
  useEffect(() => void loadRoles(), [loadRoles]);

  // Fora do app (navegador, demo) nao ha CLI para autorizar.
  const ready =
    !isInsideApp() ||
    (setup !== null && setup.gitFound && setup.adapters.every((a) => a.found && a.allowed));

  if (!ready) return <AgentSetup />;
  return project === null ? <ProjectPicker /> : <Hub />;
}
