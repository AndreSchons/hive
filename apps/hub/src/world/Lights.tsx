/**
 * Iluminacao do escritorio: a luz-chave vem do lado da camera, marcando bem o
 * lado iluminado de quem a gente ve; um preenchimento fraco do lado das
 * janelas da o contraluz. Ambiente forte para as sombras nao fecharem em
 * preto. Sem shadow map -- o ContactShadows cuida do contato.
 */
export function Lights() {
  return (
    <>
      <ambientLight intensity={0.85} />
      <hemisphereLight args={['#FFF6E8', '#D9A968', 0.35]} />
      <directionalLight position={[7, 12, 5]} intensity={1.5} color="#FFF1D6" />
      <directionalLight position={[-6, 8, -7]} intensity={0.35} color="#DFE9FF" />
    </>
  );
}
