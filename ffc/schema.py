"""Normalized analytical schema (DuckDB types). Parquet files mirror these."""

SCHEMAS: dict[str, str] = {
    "builds": """
        build_id VARCHAR, source_type VARCHAR, organization VARCHAR, display_name VARCHAR,
        subtype VARCHAR, segment VARCHAR, resolution VARCHAR,
        auspice_json_path VARCHAR, frequencies_json_path VARCHAR, root_sequence_json_path VARCHAR,
        manifest_metadata VARCHAR, json_metadata VARCHAR, json_title VARCHAR,
        build_date VARCHAR, updated_date VARCHAR,
        most_recent_sample_date DATE, min_sample_date DATE, max_sample_date DATE,
        total_tip_count INTEGER, dated_tip_count INTEGER, tips_with_frequency INTEGER,
        downsampling_description VARCHAR, frequency_source VARCHAR, frequency_source_detail VARCHAR,
        pivot_count INTEGER, projection_pivot DOUBLE,
        clade_field VARCHAR, subclade_field VARCHAR,
        ingestion_timestamp VARCHAR, source_json_version VARCHAR, source_sha256 VARCHAR,
        remote VARCHAR, fetched_at VARCHAR, synthetic BOOLEAN,
        validation_warnings VARCHAR
    """,
    "tips": """
        build_id VARCHAR, tip_id VARCHAR, parent_node_id VARCHAR, num_date DOUBLE,
        collection_date DATE, region VARCHAR, country VARCHAR, division VARCHAR, location VARCHAR,
        host VARCHAR, clade VARCHAR, subclade VARCHAR, metadata_json VARCHAR,
        genotype_annotations_json VARCHAR, pivot_bin INTEGER
    """,
    "tip_attrs": "build_id VARCHAR, tip_id VARCHAR, field VARCHAR, value VARCHAR",
    "pivots": "build_id VARCHAR, pivot_idx INTEGER, num_date DOUBLE, date DATE, month VARCHAR, is_projection BOOLEAN",
    "tip_frequencies": "build_id VARCHAR, tip_id VARCHAR, pivot_idx INTEGER, weight DOUBLE",
    "tip_genotypes": "build_id VARCHAR, tip_id VARCHAR, gene VARCHAR, position INTEGER, state VARCHAR",
    "genotype_positions": """
        build_id VARCHAR, gene VARCHAR, position INTEGER, root_state VARCHAR,
        n_tips_nonroot INTEGER, n_states INTEGER, state_counts VARCHAR
    """,
    "gene_annotations": """
        build_id VARCHAR, gene VARCHAR, start_pos INTEGER, end_pos INTEGER, strand VARCHAR,
        seq_type VARCHAR, has_mutations BOOLEAN
    """,
    "root_sequences": "build_id VARCHAR, gene VARCHAR, sequence VARCHAR",
    "color_scales": "build_id VARCHAR, coloring_key VARCHAR, value VARCHAR, color VARCHAR",
    # values of clade/subclade fields over ALL tree nodes, in pre-order of first appearance
    # (what Auspice uses to order greys and default-palette colours)
    "value_order": "build_id VARCHAR, coloring_key VARCHAR, value VARCHAR, first_index INTEGER, n_nodes INTEGER",
    "available_metadata_fields": """
        build_id VARCHAR, field_name VARCHAR, field_title VARCHAR, field_type VARCHAR,
        allowed_values VARCHAR, n_tips_with_value INTEGER, source_location_in_json VARCHAR
    """,
    "frequency_observations": """
        build_id VARCHAR, source_type VARCHAR, subtype VARCHAR, segment VARCHAR,
        grouping_type VARCHAR, genotype_definition VARCHAR, taxon_label VARCHAR,
        pivot_idx INTEGER, date_bin DATE, num_date DOUBLE, month VARCHAR, is_projection BOOLEAN,
        frequency DOUBLE, numerator_count INTEGER, denominator_count INTEGER,
        filter_context_hash VARCHAR, calculation_method VARCHAR
    """,
    "reference_colors": """
        subtype VARCHAR, segment VARCHAR, coloring_key VARCHAR, value VARCHAR, color VARCHAR,
        rank INTEGER, sources VARCHAR, fetched_at VARCHAR
    """,
    "comparison_observations": """
        local_build_id VARCHAR, global_build_id VARCHAR, subtype VARCHAR, segment VARCHAR,
        grouping_type VARCHAR, genotype_definition VARCHAR, taxon_label VARCHAR, date_bin VARCHAR,
        local_frequency DOUBLE, global_frequency DOUBLE, difference_percentage_points DOUBLE,
        local_numerator_count INTEGER, local_denominator_count INTEGER,
        global_numerator_count INTEGER, global_denominator_count INTEGER,
        local_pivot_date DATE, global_pivot_date DATE,
        alignment_method VARCHAR, filter_context_hash VARCHAR
    """,
}

PER_BUILD_TABLES = [
    "builds", "tips", "tip_attrs", "pivots", "tip_frequencies", "tip_genotypes",
    "genotype_positions", "gene_annotations", "root_sequences", "color_scales",
    "value_order", "available_metadata_fields",
]
DERIVED_TABLES = ["frequency_observations", "comparison_observations", "reference_colors"]


def columns(table: str) -> list[str]:
    cols = []
    for part in SCHEMAS[table].replace("\n", " ").split(","):
        part = part.strip()
        if part:
            cols.append(part.split()[0])
    return cols
