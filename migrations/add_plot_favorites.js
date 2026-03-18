const { pool } = require('../db');

async function addPlotFavorites() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Create plot_favorites table (MySQL syntax)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS plot_favorites (
        id CHAR(36) PRIMARY KEY,
        user_id CHAR(36),
        property_id CHAR(36),
        plot_id CHAR(36),
        plot_type VARCHAR(20) NOT NULL,
        plot_number VARCHAR(50),
        plot_details JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_plot (user_id, property_id, plot_id, plot_type),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    // Create indexes
    await connection.execute(`CREATE INDEX IF NOT EXISTS idx_plot_favorites_user_id ON plot_favorites(user_id)`);
    await connection.execute(`CREATE INDEX IF NOT EXISTS idx_plot_favorites_property_id ON plot_favorites(property_id)`);
    await connection.execute(`CREATE INDEX IF NOT EXISTS idx_plot_favorites_plot_id ON plot_favorites(plot_id)`);
    await connection.execute(`CREATE INDEX IF NOT EXISTS idx_plot_favorites_plot_type ON plot_favorites(plot_type)`);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  addPlotFavorites()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      process.exit(1);
    });
}

module.exports = { addPlotFavorites };