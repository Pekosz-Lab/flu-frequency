export default function Methodology({ text }: { text: Record<string, any> }) {
  return (
    <div className="methodology">
        <h3>Methodology and caveats</h3>
        <p>{text.caveat}</p>
        <ul>
          {(text.caveat_points as string[]).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
        <h3>How frequencies are computed</h3>
        <p>
          Each build's per-tip KDE frequencies (the <code>*_tip-frequencies.json</code> written by <code>augur frequencies</code>, as used by Auspice) are summed by clade,
          subclade or genotype at each time pivot and divided by the summed frequency of all included tips at that pivot. Filtering renormalises over the remaining
          tips, as Auspice does. If a build has no frequency file, frequencies are recomputed from tip dates with augur's KDE defaults; the provenance panel says which.
          Genotypes are reconstructed from the mutations on the tree's branches (root state from the build's root-sequence JSON when supplied).
        </p>
        <p>Difference = local relative frequency − global relative frequency, shown in percentage points.</p>
        <h3>Time alignment</h3>
        <p>{text.alignment}</p>
        <h3>Counts</h3>
        <p>{text.counts}</p>
        <h3>Figure footnote</h3>
        <p>
          <em>{text.footnote}</em>
        </p>
    </div>
  );
}
