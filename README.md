# API Route Prefix

In production, all backend API routes are prefixed with `/backend`. For example:

- `GET /backend/api/settings/feature-toggles?department=Sales&role=admin`
- `POST /backend/api/auth/login`

If you use `/api/...` directly, you will receive the frontend HTML instead of the API response.
# Real Estate App Backend - Production Ready

This is the production-ready backend for the Real Estate App, configured for shared hosting deployment.

## 🚀 Production Configuration

This backend is pre-configured for deployment to:
 Host: http://cewealthzen.com/backend
 **Database**: cewealthzen_real_estate_db (MySQL)
 **User**: cewealthzen_mobile_application

## 📦 Quick Deployment

### Prerequisites
 - **Name**: cewealthzen_real_estate_db
### Installation Steps

1. **Upload Files**: Upload this entire backend folder to your hosting server

2. **Install Dependencies**:
```bash
npm install
```

3. **Import Database**: Import the `schema.sql` file into your MySQL database

4. **Set Permissions**: Ensure upload directories have write permissions:
```bash
chmod 755 public/uploads/
```

5. **Start Server**:
```bash
npm start
```

## 🧪 Testing After Deployment

### Health Check Endpoints
Test these URLs after deployment:

**API Health Check:**
```
http://cewealthzen.com/backend/api/health
```

**Mobile Health Check:**
```
http://cewealthzen.com/backend/mobile-health
```

### Main API Endpoints

The backend provides comprehensive REST API endpoints for:
- **Authentication**: User registration, login, password management
- **Properties**: CRUD operations for property listings
- **Land Management**: Advanced block and plot management system
- **User Management**: Profile management and admin functions
- **Favorites**: Property and plot-level favorites
- **Enquiries**: Customer inquiry management
- **File Uploads**: Image and document handling
- **Cities & Banners**: Content management

## 🔧 Configuration Details

### Environment Variables
All configuration is set for production hosting:
- Database credentials configured for your hosting
- CORS enabled for your domain
- File upload paths optimized
- Security headers configured

### Database
- **Type**: MySQL
- **Name**: creativeethicsco_real_estate_db
- **Optimized**: Performance indexes included
- **Schema**: Complete with all required tables and functions

## 📁 File Structure

```
backend/
├── middleware/           # Authentication & security middleware
├── routes/              # Complete API routes (15+ endpoints)
├── services/            # Email and verification services
├── utils/               # Utility functions and helpers
├── migrations/          # Database migration scripts
├── public/              # Static files and uploads
│   └── uploads/         # Organized upload directories
├── .env                 # Production environment (hosting database)
├── .env.production      # Backup production environment
├── .htaccess           # Server configuration for shared hosting
├── db.js               # Optimized database connection
├── server.js           # Production-ready server
├── start.js            # Production startup script
├── schema.sql          # Complete database schema with optimizations
├── package.json        # Production dependencies and scripts
├── DEPLOYMENT_GUIDE.md # Detailed deployment instructions
└── DEPLOYMENT_SUMMARY.md # Quick deployment summary
```

## 🎯 Ready for Production

This backend folder contains **only production configuration** - no local database references. Simply upload, install dependencies, import the database schema, and start the server!

For detailed deployment instructions, see `DEPLOYMENT_GUIDE.md`.# Real Estate App Backend - Production Ready

This is the production-ready backend for the Real Estate App, configured for shared hosting deployment.

## 🚀 Production Configuration

This backend is pre-configured for deployment to:
- **Host**: http://cewealthzen.com
- **Database**: creativeethicsco_real_estate_db (MySQL)
- **User**: creativeethicsco_mobile_application

## 📦 Quick Deployment

### Prerequisites
- Node.js support on your hosting provider
- MySQL database access
- File upload permissions

### Installation Steps

1. **Upload Files**: Upload this entire backend folder to your hosting server

2. **Install Dependencies**:
```bash
npm install
```

3. **Import Database**: Import the `schema.sql` file into your MySQL database

4. **Set Permissions**: Ensure upload directories have write permissions:
```bash
chmod 755 public/uploads/
```

5. **Start Server**:
```bash
npm start
```

## 🧪 Testing After Deployment

### Health Check Endpoints
Test these URLs after deployment:

**API Health Check:**
```
http://cewealthzen.com/api/health
```

**Mobile Health Check:**
```
http://cewealthzen.com/mobile-health
```

### Main API Endpoints

The backend provides comprehensive REST API endpoints for:
- **Authentication**: User registration, login, password management
- **Properties**: CRUD operations for property listings
- **Land Management**: Advanced block and plot management system
- **User Management**: Profile management and admin functions
- **Favorites**: Property and plot-level favorites
- **Enquiries**: Customer inquiry management
- **File Uploads**: Image and document handling
- **Cities & Banners**: Content management

## 🔧 Configuration Details

### Environment Variables
All configuration is set for production hosting:
- Database credentials configured for your hosting
- CORS enabled for your domain
- File upload paths optimized
- Security headers configured

### Database
- **Type**: MySQL
- **Name**: creativeethicsco_real_estate_db
- **Optimized**: Performance indexes included
- **Schema**: Complete with all required tables and functions

## 📁 File Structure

```
backend/
├── middleware/           # Authentication & security middleware
├── routes/              # Complete API routes (15+ endpoints)
├── services/            # Email and verification services
├── utils/               # Utility functions and helpers
├── migrations/          # Database migration scripts
├── public/              # Static files and uploads
│   └── uploads/         # Organized upload directories
├── .env                 # Production environment (hosting database)
├── .env.production      # Backup production environment
├── .htaccess           # Server configuration for shared hosting
├── db.js               # Optimized database connection
├── server.js           # Production-ready server
├── start.js            # Production startup script
├── schema.sql          # Complete database schema with optimizations
├── package.json        # Production dependencies and scripts
├── DEPLOYMENT_GUIDE.md # Detailed deployment instructions
└── DEPLOYMENT_SUMMARY.md # Quick deployment summary
```

## 🎯 Ready for Production

This backend folder contains **only production configuration** - no local database references. Simply upload, install dependencies, import the database schema, and start the server!

For detailed deployment instructions, see `DEPLOYMENT_GUIDE.md`.