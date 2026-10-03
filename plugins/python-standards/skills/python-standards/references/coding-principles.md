# Clean code principles for Python Projects

## 1. Single Responsibility Principle (SRP)

**Principle:** Each class or function should have only one reason to change and one responsibility.

### Bad Example
```python
# One class does everything
class StudentReport:
    def __init__(self, name, marks):
        self.name = name
        self.marks = marks  # dict: {'math': 85, 'science': 90}

    def calculate_average(self):
        return sum(self.marks.values()) / len(self.marks)

    def determine_grade(self):
        avg = self.calculate_average()
        if avg >= 90:
            return 'A'
        elif avg >= 75:
            return 'B'
        elif avg >= 60:
            return 'C'
        else:
            return 'D'

    def save_to_file(self):
        with open("report.txt", "a") as f:
            f.write(f"{self.name}, {self.marks}, Grade: {self.determine_grade()}\n")

    def print_report(self):
        print(f"Student: {self.name}")
        print("Marks:")
        for subject, mark in self.marks.items():
            print(f"  {subject}: {mark}")
        print(f"Grade: {self.determine_grade()}")


```

### Good Example
```python
# Separate class for each responsibility
class Student:
    def __init__(self, name, marks):
        self.name = name
        self.marks = marks  # {'math': 85, 'science': 90}

class GradeCalculator:
    def calculate_average(self, student):
        return sum(student.marks.values()) / len(student.marks)

    def determine_grade(self, student):
        avg = self.calculate_average(student)
        if avg >= 90:
            return 'A'
        elif avg >= 75:
            return 'B'
        elif avg >= 60:
            return 'C'
        else:
            return 'D'

class ReportSaver:
    def save(self, student, grade):
        with open("report.txt", "a") as f:
            f.write(f"{student.name}, {student.marks}, Grade: {grade}\n")

class ReportPrinter:
    def print(self, student, grade):
        print(f"Student: {student.name}")
        print("Marks:")
        for subject, mark in student.marks.items():
            print(f"  {subject}: {mark}")
        print(f"Grade: {grade}")

```

## 2. Don't Repeat Yourself (DRY)

**Principle:** Avoid code duplication by abstracting common functionality.

### Bad Example
```python
import logging

def process_order(order_id):
    logging.basicConfig(level=logging.INFO)
    logging.info(f"Processing order {order_id}")
    # processing logic here

def cancel_order(order_id):
    logging.basicConfig(level=logging.INFO)
    logging.info(f"Cancelling order {order_id}")
    # cancel logic here

```

### Good Example
```python
import logging

# Set up logger once
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def process_order(order_id):
    logger.info(f"Processing order {order_id}")
    # processing logic here

def cancel_order(order_id):
    logger.info(f"Cancelling order {order_id}")
    # cancel logic here

# we can further abstract logging if needed
```

## 3. KISS (Keep It Simple, Stupid)

**Principle:** Write simple, readable code that's easy to understand and maintain.

### When List Comprehensions Are Too Complex (Bad)
```python
# Too complex - multiple conditions, repeated operations
def process_data(data):
    return [item.upper().strip() for item in data if item and len(item.strip()) > 0 and not item.strip().startswith('#')]

# Complex nested comprehension
def matrix_operation(matrix):
    return [[cell * 2 if cell > 0 else abs(cell) for cell in row if cell != 0] for row in matrix if any(cell != 0 for cell in row)]
```

### When List Comprehensions Are Perfect (Good)
```python
# Simple, readable list comprehensions
def get_even_numbers(numbers):
    return [n for n in numbers if n % 2 == 0]

def square_numbers(numbers):
    return [n ** 2 for n in numbers]

def filter_valid_emails(emails):
    return [email for email in emails if '@' in email]
```

### Complex Logic Should Be Explicit (Good)
```python
def process_data(data):
    processed_items = []
    for item in data:
        if not item:
            continue
        
        cleaned_item = item.strip()
        if len(cleaned_item) > 0 and not cleaned_item.startswith('#'):
            processed_items.append(cleaned_item.upper())
    
    return processed_items

# Or break it down into helper functions
def is_valid_item(item):
    if not item:
        return False
    cleaned = item.strip()
    return len(cleaned) > 0 and not cleaned.startswith('#')

def process_data_functional(data):
    return [item.upper().strip() for item in data if is_valid_item(item)]
```

### Rule of Thumb for List Comprehensions
- **Use them when:** Single condition, simple transformation, fits on one line comfortably
- **Avoid them when:** Multiple conditions, complex logic, hard to read at first glance
- **Consider alternatives:** Helper functions, generator expressions, or explicit loops for complex cases


## 4. YAGNI (You Aren't Gonna Need It)

**Principle:** Don't implement features until you actually need them.

### Bad Example
```python
class Calculator:
    def add(self, a, b):
        return a + b
    
    def subtract(self, a, b):
        return a - b
    
    def multiply(self, a, b):
        return a * b
    
    def divide(self, a, b):
        return a / b
    
    # Unnecessary complexity for current needs
    def calculate_logarithm(self, base, number):
        pass
    
    def calculate_sine(self, angle):
        pass
    
    def calculate_cosine(self, angle):
        pass
```

### Good Example
```python
class Calculator:
    def add(self, a, b):
        return a + b
    
    def subtract(self, a, b):
        return a - b
    
    # Only implement what you need right now
    # Add more methods when actually required
```

## 5. Composition over Inheritance

**Principle:** Instead of making classes inherit everything from a parent, try using smaller objects that work together — it's easier to change and reuse later.

### Bad Example
```python
class Animal:
    def __init__(self, name):
        self.name = name

class Flyer(Animal):
    def fly(self):
        return f"{self.name} is flying"

class Swimmer(Animal):
    def swim(self):
        return f"{self.name} is swimming"

class Duck(Flyer, Swimmer):
    pass

# Usage
duck = Duck("Duck")
print(duck.fly())
print(duck.swim())

# Duck is tied to Flyer and Swimmer — tight coupling.
# Can't reuse Flyer or Swimmer easily outside of animals.
```

### Good Example
```python
class Animal:
    def __init__(self, name):
        self.name = name
    

class Flyer:
    def fly(self, name):
        return f"{name} is flying"

class Swimmer:
    def swim(self, name):
        return f"{name} is swimming"

class Duck:
    def __init__(self, name):
        self.name = name
        self.flyer = Flyer()
        self.swimmer = Swimmer()

    def fly(self):
        return self.flyer.fly(self.name)

    def swim(self):
        return self.swimmer.swim(self.name)

# Usage
duck = Duck("Duck")
print(duck.fly())   
print(duck.swim())     
```

## 6. Dependency Inversion Principle

**Principle:** High-level modules should not depend on low-level modules. Both should depend on abstractions.

### Bad Example
```python
class MySQLDatabase:
    def save(self, data):
        # SQL specific code
        print(f"Saving {data} to MySQL")

class UserService:
    def __init__(self):
        self.db = MySQLDatabase()  # Tight coupling

    def create_user(self, user_data):
        # Process user data
        self.db.save(user_data)
```

### Good Example
```python
from abc import ABC, abstractmethod

class Database(ABC):
    @abstractmethod
    def save(self, data):
        pass

class MySQLDatabase(Database):
    def save(self, data):
        print(f"Saving {data} to MySQL")

class PostgreSQLDatabase(Database):
    def save(self, data):
        print(f"Saving {data} to PostgreSQL")

class UserService:
    def __init__(self, database: Database):
        self.db = database  # Depends on abstraction
    
    def create_user(self, user_data):
        # Process user data
        self.db.save(user_data)

# Usage
mysql_db = MySQLDatabase()
user_service = UserService(mysql_db)
```

## 7. Law of Demeter (Principle of Least Knowledge)

**Principle:** A method should only call methods on itself, its own fields, parameters, objects it createsIn short, an object should only talk to its immediate friends, not to strangers.

### Bad Example
```python
class Country:
    def __init__(self, name):
        self.name = name

class Address:
    def __init__(self, street, country):
        self.street = street
        self.country = country

class Customer:
    def __init__(self, name, address):
        self.name = name
        self.address = address

class ShoppingCart:
    def __init__(self, customer):
        self.customer = customer

    def print_shipping_country(self):
        # Chaining through customer → address → country
        print(self.customer.address.country.name)  # Too much knowledge of structure

```

### Good Example
```python
class Country:
    def __init__(self, name):
        self.name = name

    def get_name(self):
        return self.name

class Address:
    def __init__(self, street, country):
        self.street = street
        self.country = country

    def get_country_name(self):
        return self.country.get_name()

class Customer:
    def __init__(self, name, address):
        self.name = name
        self.address = address

    def get_shipping_country(self):
        return self.address.get_country_name()

class ShoppingCart:
    def __init__(self, customer):
        self.customer = customer

    def print_shipping_country(self):
        print(self.customer.get_shipping_country())  # One level of knowledge

```

## 8. Open/Closed Principle

**Principle:** Software entities should be open for extension but closed for modification.

### Bad Example
```python
class DiscountCalculator:
    def calculate_discount(self, customer_type, amount):
        if customer_type == "regular":
            return amount * 0.05
        elif customer_type == "premium":
            return amount * 0.10
        elif customer_type == "vip":
            return amount * 0.15
        # Need to modify this method for new customer types
```

### Good Example
```python
from abc import ABC, abstractmethod

class DiscountStrategy(ABC):
    @abstractmethod
    def calculate_discount(self, amount):
        pass

class RegularCustomerDiscount(DiscountStrategy):
    def calculate_discount(self, amount):
        return amount * 0.05

class PremiumCustomerDiscount(DiscountStrategy):
    def calculate_discount(self, amount):
        return amount * 0.10

class VIPCustomerDiscount(DiscountStrategy):
    def calculate_discount(self, amount):
        return amount * 0.15

class DiscountCalculator:
    def __init__(self, strategy: DiscountStrategy):
        self.strategy = strategy
    
    def calculate_discount(self, amount):
        return self.strategy.calculate_discount(amount)

# Easy to extend with new discount types without modifying existing code
```

## 9. Liskov Substitution Principle

**Principle:** Objects of a superclass should be replaceable with objects of a subclass without breaking the application.

### Bad Example
```python
class Rectangle:
    def __init__(self, width, height):
        self.width = width
        self.height = height

    def set_width(self, width):
        self.width = width

    def set_height(self, height):
        self.height = height

    def area(self):
        return self.width * self.height

class Triangle(Rectangle):
    def area(self):
        # Triangle overrides area formula
        # It's not a rectangle, so it violates LSP
        return 0.5 * self.width * self.height

```

### Good Example
```python
from abc import ABC, abstractmethod

class Shape(ABC):
    @abstractmethod
    def area(self):
        pass

class Rectangle(Shape):
    def __init__(self, width, height):
        self.width = width
        self.height = height
    
    def area(self):
        return self.width * self.height

class Triangle(Shape):
    def __init__(self, base, height):
        self.base = base
        self.height = height

    def area(self):
        return 0.5 * self.base * self.height
```

## 10. Interface Segregation Principle

**Principle:** No client should be forced to depend on methods it does not use.

### Bad Example
```python
class Worker:
    def work(self):
        pass

    def take_break(self):
        pass

    def rest(self):
        pass

class HumanWorker(Worker):
    def work(self):
        print("Human is working")

    def take_break(self):
        print("Human is taking a lunch break")

    def rest(self):
        print("Human is resting after work")

class RobotWorker(Worker):
    def work(self):
        print("Robot is working")

    def take_break(self):
        pass  # Unused

    def rest(self):
        pass  # Unused

```

### Good Example
```python
from abc import ABC, abstractmethod

class Work(ABC):
    @abstractmethod
    def work(self):
        pass

class Break(ABC):
    @abstractmethod
    def take_break(self):
        pass

class Rest(ABC):
    @abstractmethod
    def rest(self):
        pass

class HumanWorker(Work, Break, Rest):
    def work(self):
        print("Human is working")

    def take_break(self):
        print("Human is taking a lunch break")

    def rest(self):
        print("Human is resting after work")

class RobotWorker(Work):
    def work(self):
        print("Robot is working")
```

## 11. Separation of Concerns

**Principle:** Separate different aspects of the program into distinct sections.

### Bad Example
```python
def process_user_data(user_input):
    # Validation mixed with processing and output
    if not user_input or len(user_input) < 3:
        print("Invalid input")
        return None
    
    processed_data = user_input.upper().strip()
    
    # Save to database
    print(f"Saving {processed_data} to database")
    
    # Send notification
    print(f"Sending notification about {processed_data}")
    
    return processed_data
```

### Good Example
```python
class InputValidator:
    def validate(self, user_input):
        return user_input and len(user_input) >= 3

class DataProcessor:
    def process(self, data):
        return data.upper().strip()

class DatabaseService:
    def save(self, data):
        print(f"Saving {data} to database")

class NotificationService:
    def send(self, data):
        print(f"Sending notification about {data}")

def process_user_data(user_input):
    validator = InputValidator()
    processor = DataProcessor()
    db_service = DatabaseService()
    notification_service = NotificationService()
    
    if not validator.validate(user_input):
        print("Invalid input")
        return None
    
    processed_data = processor.process(user_input)
    db_service.save(processed_data)
    notification_service.send(processed_data)
    
    return processed_data
```

## 12. Error Handling Best Practices

**Principle:** Handle errors gracefully and provide meaningful feedback.

### Bad Example
```python
def divide_numbers(a, b):
    return a / b  # No error handling

def read_file(filename):
    file = open(filename, 'r')
    content = file.read()
    file.close()
    return content  # No error handling
```

### Good Example
```python
def divide_numbers(a, b):
    try:
        if b == 0:
            raise ValueError("Division by zero is not allowed")
        return a / b
    except (TypeError, ValueError) as e:
        print(f"Error in division: {e}")
        return None

def read_file(filename):
    try:
        with open(filename, 'r') as file:
            return file.read()
    except FileNotFoundError:
        print(f"File {filename} not found")
        return None
    except PermissionError:
        print(f"Permission denied to read {filename}")
        return None
    except Exception as e:
        print(f"Unexpected error reading file: {e}")
        return None
```

