/** Iluminacao do escritorio. Nao sabe o que ha no chao. */
export function Lights() {
  return (
    <>
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#93b4ff', '#0b0f17', 0.7]} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
      />
      <directionalLight position={[-9, 6, -7]} intensity={0.35} color="#7f9cff" />
    </>
  );
}
