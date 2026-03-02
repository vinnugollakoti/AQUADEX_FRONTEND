type SimplePageProps = {
  title: string
  description: string
}

export function SimplePage({ title, description }: SimplePageProps) {
  return (
    <section className="content-section">
      <h2>{title}</h2>
      <p className="section-copy">{description}</p>
    </section>
  )
}
