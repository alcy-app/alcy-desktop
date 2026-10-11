import './loading-bar.css'

/** Barra fina indeterminada (sem porcentagem conhecida) — mesma animação usada
 * para uma requisição em andamento (`ResponsePanel`), reaproveitada em
 * qualquer lugar que precise do mesmo sinal visual de "algo está acontecendo". */
export function LoadingBar() {
  return (
    <div className="ui-loading-bar" aria-hidden="true">
      <div className="ui-loading-bar-fill" />
    </div>
  )
}
