// scrapers/IScraper.ts — interfaz común de un scraper consultable.
// La implementan el sujeto real (AntecedentesScraper) y el Proxy (CachingScraperProxy),
// así el cliente le habla igual a cualquiera de los dos (patrón Proxy).
export interface IScraper {
  consultar(cedula: string, tipo: string): Promise<any>;
}
