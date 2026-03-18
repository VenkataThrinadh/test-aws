const { pool } = require('../db');

async function createDocumentsTables() {
  try {
    console.log('Creating documents tables...');

    // Create document_categories table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS document_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        color VARCHAR(7) DEFAULT '#007bff',
        icon VARCHAR(50) DEFAULT 'folder',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create documents table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category_id INT,
        property_id INT,
        original_filename VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size BIGINT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        tags TEXT,
        status ENUM('active', 'archived', 'deleted') DEFAULT 'active',
        uploaded_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES document_categories(id) ON DELETE SET NULL,
        FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_property_id (property_id),
        INDEX idx_category_id (category_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `);

    // Create document_versions table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS document_versions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        version_number INT NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size BIGINT NOT NULL,
        change_description TEXT,
        uploaded_by INT NOT NULL,
        is_current BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_document_version (document_id, version_number),
        INDEX idx_document_id (document_id),
        INDEX idx_is_current (is_current)
      )
    `);

    // Create document_activity_logs table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS document_activity_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        action ENUM('upload', 'update', 'delete', 'download', 'view') NOT NULL,
        performed_by INT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_document_id (document_id),
        INDEX idx_action (action),
        INDEX idx_created_at (created_at)
      )
    `);

    // Insert default document categories
    await pool.execute(`
      INSERT IGNORE INTO document_categories (name, description, color, icon) VALUES
      ('Legal Documents', 'Legal contracts, agreements, and certificates', '#dc3545', 'gavel'),
      ('Property Papers', 'Property deeds, titles, and ownership documents', '#28a745', 'home'),
      ('Financial Records', 'Invoices, receipts, and financial statements', '#ffc107', 'attach_money'),
      ('Images', 'Property photos and visual documentation', '#17a2b8', 'photo'),
      ('Plans & Drawings', 'Architectural plans, blueprints, and technical drawings', '#6f42c1', 'architecture'),
      ('Certificates', 'Compliance certificates and approvals', '#fd7e14', 'verified'),
      ('Reports', 'Inspection reports, surveys, and assessments', '#20c997', 'assessment'),
      ('Correspondence', 'Emails, letters, and communication records', '#6c757d', 'mail'),
      ('Other', 'Miscellaneous documents', '#495057', 'description')
    `);

    console.log('✅ Documents tables created successfully!');
    console.log('✅ Default document categories inserted!');

  } catch (error) {
    console.error('❌ Error creating documents tables:', error);
    throw error;
  }
}

// Run migration if called directly
if (require.main === module) {
  createDocumentsTables()
    .then(() => {
      console.log('Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { createDocumentsTables };