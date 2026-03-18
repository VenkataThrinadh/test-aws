const { pool } = require('../db');
const logger = require('../utils/logger');

class NotificationService {
  /**
   * Get the next employee (round-robin) for a property
   */
  static async getNextAssignedEmployee(propertyId) {
    // Get all employees assigned to this property
    const [employees] = await pool.execute(
      `SELECT employee_id FROM property_employee_assignment WHERE property_id = ? ORDER BY id ASC`,
      [propertyId]
    );
    if (!employees.length) return null;

    // Get the last assigned employee for this property
    const [pointerRows] = await pool.execute(
      `SELECT last_employee_id FROM property_notification_pointer WHERE property_id = ?`,
      [propertyId]
    );
    let nextEmployeeId;
    if (!pointerRows.length || !pointerRows[0].last_employee_id) {
      // No pointer yet, assign to the first employee
      nextEmployeeId = employees[0].employee_id;
    } else {
      // Find the next employee in the list
      const lastId = pointerRows[0].last_employee_id;
      const idx = employees.findIndex(e => e.employee_id === lastId);
      if (idx === -1 || idx === employees.length - 1) {
        nextEmployeeId = employees[0].employee_id;
      } else {
        nextEmployeeId = employees[idx + 1].employee_id;
      }
    }
    // Update the pointer
    await pool.execute(
      `REPLACE INTO property_notification_pointer (property_id, last_employee_id) VALUES (?, ?)`,
      [propertyId, nextEmployeeId]
    );
    return nextEmployeeId;
  }
  /**
   * Create a new notification
   * @param {string} type - Type of notification (enquiry, user_registration, property_added, etc.)
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} data - Additional data (user_id, property_id, enquiry_id, etc.)
   */
  static async createNotification(type, title, message, data = {}) {
    try {
      const [result] = await pool.execute(
        `INSERT INTO notifications (type, title, message, data, created_at) 
         VALUES (?, ?, ?, ?, NOW())`,
        [type, title, message, JSON.stringify(data)]
      );
      
      logger.info(`Notification created: ${type} - ${title}`);
      return result.insertId;
    } catch (error) {
      logger.error('Error creating notification:', error);
      throw error;
    }
  }

  /**
   * Create notification for new enquiry
   */
  static async createEnquiryNotification(enquiry, user, property, assignedStaff = null) {
    const title = 'New Property Enquiry';
    const message = `${user?.full_name || user?.email || 'A user'} has sent an enquiry for "${property?.title || 'a property'}"`;
    const data = {
      enquiry_id: enquiry.id,
      user_id: user?.id,
      property_id: property?.id,
      user_name: user?.full_name || user?.email,
      user_email: user?.email,
      user_phone: enquiry.phone,
      property_title: property?.title,
      enquiry_message: enquiry.message
    };

    // If assigned staff is provided, include their details
    if (assignedStaff) {
      data.assigned_staff_id = assignedStaff.id;
      data.assigned_staff_name = assignedStaff.full_name;
      data.assigned_staff_phone = assignedStaff.phone;
      data.assigned_staff_email = assignedStaff.email;
      data.assigned_staff_designation = assignedStaff.designation;
    }

    return await this.createNotification('enquiry', title, message, data);
  }

  /**
   * Create notification for new user registration
   */
  static async createUserRegistrationNotification(user) {
    const title = 'New User Registration';
    const message = `${user.full_name || user.email} has registered as a new user`;
    
    const data = {
      user_id: user.id,
      user_name: user.full_name,
      user_email: user.email,
      user_role: user.role
    };

    return await this.createNotification('user_registration', title, message, data);
  }

  /**
   * Create notification for new property added
   */
  static async createPropertyNotification(property, user) {
    const title = 'New Property Added';
    const message = `A new property "${property.title}" has been added by ${user?.full_name || user?.email}`;
    
    const data = {
      property_id: property.id,
      user_id: user?.id,
      property_title: property.title,
      property_type: property.property_type,
      property_price: property.price,
      property_city: property.city
    };

    return await this.createNotification('property_added', title, message, data);
  }

  /**
   * Get recent notifications
   */
  static async getRecentNotifications(limit = 10) {
    try {
      const [notifications] = await pool.execute(
        `SELECT 
          n.id,
          n.type,
          n.title,
          n.message,
          n.data,
          n.is_read,
          n.created_at
        FROM notifications n
        ORDER BY n.created_at DESC
        LIMIT ?`,
        [limit]
      );

      return notifications.map(notification => ({
        ...notification,
        data: notification.data ? JSON.parse(notification.data) : null
      }));
    } catch (error) {
      logger.error('Error fetching recent notifications:', error);
      throw error;
    }
  }

  /**
   * Get unread notifications count
   */
  static async getUnreadCount() {
    try {
      const [result] = await pool.execute(
        'SELECT COUNT(*) as count FROM notifications WHERE is_read = FALSE'
      );
      
      return result[0].count;
    } catch (error) {
      logger.error('Error fetching unread count:', error);
      throw error;
    }
  }
}

module.exports = NotificationService;