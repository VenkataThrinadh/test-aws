const { pool } = require('../db');

async function addPlotColumnsToDocuments() {
  try {
    console.log('🔧 Checking and adding plot columns to documents table if needed...');

    // Check if plot_id exists
    const [plotIdColumn] = await pool.execute("SHOW COLUMNS FROM documents LIKE 'plot_id'");
    const hasPlotId = plotIdColumn.length > 0;

    // Check if plot_type exists
    const [plotTypeColumn] = await pool.execute("SHOW COLUMNS FROM documents LIKE 'plot_type'");
    const hasPlotType = plotTypeColumn.length > 0;

    if (!hasPlotId) {
      console.log('➕ Adding plot_id column to documents table');
      await pool.execute("ALTER TABLE documents ADD COLUMN plot_id INT NULL AFTER property_id");
      await pool.execute("CREATE INDEX idx_plot_id ON documents(plot_id)");
    } else {
      console.log('✔️ plot_id column already exists');
    }

    if (!hasPlotType) {
      console.log('➕ Adding plot_type column to documents table');
      await pool.execute("ALTER TABLE documents ADD COLUMN plot_type ENUM('plot','land_plot','property_block') NULL AFTER plot_id");
    } else {
      console.log('✔️ plot_type column already exists');
    }

    console.log('✅ Migration complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Run directly
if (require.main === module) {
  addPlotColumnsToDocuments()
    .then(() => { console.log('Done'); process.exit(0); })
    .catch(() => { process.exit(1); });
}

module.exports = { addPlotColumnsToDocuments };