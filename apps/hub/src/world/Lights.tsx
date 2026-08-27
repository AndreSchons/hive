/**
 * Iluminacao do escritorio: ambiente forte para as cores ficarem vivas, mais
 * uma direcional para dar volume. Sem shadow map -- a sombra de contato vem
 * do ContactShadows na cena, que combina mais com o visual e custa menos.
 */
export function Lights() {
  return (
    <>
      <ambientLight intensity={1.2} />
      <hemisphereLight args={['#FFF6E8', '#E3D9C9', 0.5]} />
      <directionalLight position={[6, 12, 4]} intensity={1.1} color="#FFF2DF" />
      <directionalLight position={[-8, 6, -6]} intensity={0.3} color="#DFE9FF" />
    </>
  );
}
