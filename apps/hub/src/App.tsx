import { useEffect } from 'react';
import { Hub } from './screens/Hub';
import { ProjectPicker } from './screens/ProjectPicker';
import { useHub } from './state/world-store';

export function App() {
  const project = useHub((state) => state.project);
  const subscribe = useHub((state) => state.subscribe);

  // Assina os eventos uma vez, para a vida inteira da janela: trocar de projeto
  // nao pode derrubar a assinatura no meio de uma execucao.
  useEffect(() => subscribe(), [subscribe]);

  return project === null ? <ProjectPicker /> : <Hub />;
}
